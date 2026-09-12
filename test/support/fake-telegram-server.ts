import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TelegramMessage } from "../../src/types.ts";

interface TelegramUpdate {
	update_id: number;
	message: TelegramMessage;
}

interface PendingPoll {
	offset: number;
	response: ServerResponse;
}

interface TelegramHttpCall {
	method: string;
	body: Record<string, unknown>;
}

interface SentTelegramText {
	kind: "message" | "edit" | "draft" | "clear-draft";
	chatId: number;
	messageId: number;
	markdown: string;
	silent?: boolean;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

function apiResult(response: ServerResponse, result: unknown): void {
	writeJson(response, { ok: true, result });
}

async function waitFor<T>(find: () => T | undefined, description: string, timeout: number): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = find();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Local HTTP implementation of the small Telegram Bot API subset used by the extension. */
class FakeTelegramServer {
	readonly apiRoot: string;

	#server: Server;
	#paths: string[] = [];
	#calls: TelegramHttpCall[] = [];
	#texts: SentTelegramText[] = [];
	#nextUpdateId = 1;
	#nextIncomingMessageId = 1;
	#nextOutgoingMessageId = 1;
	#updates: TelegramUpdate[] = [];
	#pendingPolls = new Set<PendingPoll>();

	private constructor(server: Server, apiRoot: string) {
		this.#server = server;
		this.apiRoot = apiRoot;
	}

	static async start(): Promise<FakeTelegramServer> {
		let fake: FakeTelegramServer | undefined;
		const server = createServer((request, response) => {
			if (!fake) throw new Error("Fake Telegram server received a request before initialization");
			void fake.#handle(request, response);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as AddressInfo;
		fake = new FakeTelegramServer(server, `http://127.0.0.1:${address.port}`);
		return fake;
	}

	receiveText(text: string, options: { chatId?: number; userId?: number } = {}): number {
		const chatId = options.chatId ?? 100;
		const userId = options.userId ?? 42;
		const message: TelegramMessage = {
			message_id: this.#nextIncomingMessageId++,
			chat: { id: chatId, type: "private" },
			from: { id: userId, is_bot: false, first_name: "Test" },
			text,
		};
		const updateId = this.#nextUpdateId++;
		this.#updates.push({ update_id: updateId, message });
		this.#flushPolls();
		return updateId;
	}

	async waitForUpdateConsumed(updateId: number, timeout = 5_000): Promise<void> {
		await this.waitForCall(
			(call) => call.method === "getUpdates" && typeof call.body.offset === "number" && call.body.offset > updateId,
			timeout,
		);
	}

	getSentTextCount(): number {
		return this.#texts.length;
	}

	waitForCall(predicate: (call: TelegramHttpCall) => boolean, timeout = 5_000): Promise<TelegramHttpCall> {
		return waitFor(() => this.#calls.find(predicate), "Telegram API call", timeout);
	}

	async waitForText(predicate: (text: SentTelegramText) => boolean, timeout = 5_000): Promise<SentTelegramText> {
		try {
			return await waitFor(() => this.#texts.find(predicate), "Telegram text", timeout);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\nObserved: ${JSON.stringify(this.#texts)}`,
				{ cause: error },
			);
		}
	}

	getDiagnostics(): unknown {
		return { paths: this.#paths, calls: this.#calls };
	}

	async close(): Promise<void> {
		for (const poll of this.#pendingPolls) apiResult(poll.response, []);
		this.#pendingPolls.clear();
		const closed = once(this.#server, "close");
		this.#server.close();
		this.#server.closeAllConnections();
		await closed;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const url = new URL(request.url ?? "/", this.apiRoot);
			this.#paths.push(url.pathname);
			const match = /^\/bot([^/]+)\/([^/]+)$/.exec(url.pathname);
			if (!match) {
				writeJson(response, { ok: false, description: `Unexpected Telegram path: ${url.pathname}` }, 404);
				return;
			}
			const [, token, method] = match;
			if (token !== "test-token" || !method) {
				writeJson(response, { ok: false, description: "Invalid test bot token or method" }, 401);
				return;
			}

			const body = await readJson(request);
			this.#calls.push({ method, body });
			switch (method) {
				case "getUpdates":
					this.#getUpdates(response, body);
					return;
				case "setMyCommands":
				case "sendChatAction":
					apiResult(response, true);
					return;
				case "sendRichMessage": {
					const messageId = this.#nextOutgoingMessageId++;
					this.#texts.push({
						kind: "message",
						chatId: Number(body.chat_id),
						messageId,
						markdown: this.#markdown(body),
						silent: body.disable_notification === true,
					});
					apiResult(response, { message_id: messageId });
					return;
				}
				case "editMessageText": {
					const messageId = Number(body.message_id);
					this.#texts.push({
						kind: "edit",
						chatId: Number(body.chat_id),
						messageId,
						markdown: this.#markdown(body),
					});
					apiResult(response, { message_id: messageId });
					return;
				}
				case "sendRichMessageDraft": {
					const markdown = this.#markdown(body);
					this.#texts.push({
						kind: markdown ? "draft" : "clear-draft",
						chatId: Number(body.chat_id),
						messageId: Number(body.draft_id),
						markdown,
					});
					apiResult(response, true);
					return;
				}
				default:
					writeJson(response, { ok: false, description: `Unexpected Telegram method: ${method}` }, 404);
			}
		} catch (error) {
			if (!response.headersSent) {
				writeJson(response, { ok: false, description: error instanceof Error ? error.message : String(error) }, 500);
			} else {
				response.destroy(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	#markdown(body: Record<string, unknown>): string {
		const richMessage = body.rich_message;
		if (typeof richMessage !== "object" || richMessage === null || !("markdown" in richMessage)) return "";
		return typeof richMessage.markdown === "string" ? richMessage.markdown : "";
	}

	#getAvailableUpdates(offset: number): TelegramUpdate[] {
		if (offset < 0) return this.#updates.slice(offset);
		return this.#updates.filter((update) => update.update_id >= offset);
	}

	#getUpdates(response: ServerResponse, body: Record<string, unknown>): void {
		const offset = typeof body.offset === "number" ? body.offset : 0;
		const timeout = typeof body.timeout === "number" ? body.timeout : 0;
		const available = this.#getAvailableUpdates(offset);
		if (available.length > 0 || timeout === 0) {
			apiResult(response, available);
			return;
		}

		const poll = { offset, response };
		this.#pendingPolls.add(poll);
		response.once("close", () => this.#pendingPolls.delete(poll));
	}

	#flushPolls(): void {
		for (const poll of this.#pendingPolls) {
			const available = this.#getAvailableUpdates(poll.offset);
			if (available.length === 0) continue;
			this.#pendingPolls.delete(poll);
			apiResult(poll.response, available);
			break;
		}
	}
}

export function startFakeTelegramServer(): Promise<FakeTelegramServer> {
	return FakeTelegramServer.start();
}
