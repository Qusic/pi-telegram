// Turn lifecycle + pi event handlers (agent_*, message_*, tool_*). Registers
// the telegram_attach tool. Media handling lives in media.ts.
//
// A Telegram request can span multiple pi turns and retries: turn_end closes
// each tool batch, while agent_settled closes the Telegram request.
// Concurrency: no local queue. Idle → stash as `pending`, sendUserMessage,
// agent_start promotes to `active`. Busy → sendUserMessage with
// deliverAs:"steer" to inject into the running turn.

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { createApi } from "./api.ts";
import type { createMedia, QueuedAttachment } from "./media.ts";
import type { createPreview } from "./preview.ts";
import { createToolMessages } from "./toolcall.ts";
import type { TelegramMessage } from "./types.ts";
import { getMessageText, isAssistantMessage } from "./utils.ts";

const MAX_ATTACHMENTS_PER_TURN = 10;

interface TelegramTurn {
	chatId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	lastResponse?: { stopReason: AssistantMessage["stopReason"]; errorMessage: string | undefined };
	abortRequested?: boolean;
}

interface TurnDeps {
	pi: ExtensionAPI;
	api: ReturnType<typeof createApi>;
	media: ReturnType<typeof createMedia>;
	preview: ReturnType<typeof createPreview>;
}

export function createTurn(deps: TurnDeps) {
	const { pi, api, media, preview } = deps;
	const toolMessages = createToolMessages(api);

	let pending: TelegramTurn | undefined;
	let active: TelegramTurn | undefined;
	let currentAbort: (() => void) | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;

	function startTyping(chatId: number): void {
		if (typingInterval) return;
		const sendTyping = async () => {
			try {
				await api.call("sendChatAction", { chat_id: chatId, action: "typing" });
			} catch {
				// non-critical UX hint
			}
		};
		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTyping(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	async function build(messages: TelegramMessage[]): Promise<TelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const content = await media.buildPromptContent(messages);
		return {
			chatId: firstMessage.chat.id,
			queuedAttachments: [],
			content,
		};
	}

	// ---------- pi handler registration ----------

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"To send a file or generated artifact back to the user, call telegram_attach with its local path. Mentioning the path in plain text alone will not deliver the file.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), {
				minItems: 1,
				maxItems: MAX_ATTACHMENTS_PER_TURN,
			}),
		}),
		async execute(_toolCallId, params) {
			if (!active) throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
				if (active.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				active.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await toolMessages.finalize();
		await preview.finalize();
		pending = undefined;
		active = undefined;
		currentAbort = undefined;
		stopTyping();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (pending) {
			active = pending;
			pending = undefined;
		}
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!active || !isAssistantMessage(event.message)) return;
		await preview.finalize();
	});

	pi.on("message_update", (event, _ctx) => {
		if (!active || !isAssistantMessage(event.message)) return;
		preview.update(active.chatId, getMessageText(event.message));
	});

	pi.on("tool_execution_start", async (event) => {
		if (!active) return;
		await preview.finalize();
		await toolMessages.start(active.chatId, event);
	});

	pi.on("tool_execution_end", (event) => {
		if (active) toolMessages.end(event.toolCallId, event.isError);
	});

	pi.on("turn_end", async () => {
		await toolMessages.finalize();
	});

	pi.on("agent_end", async (event) => {
		await toolMessages.finalize();
		if (!active) return;
		const response = event.messages.findLast(isAssistantMessage);
		if (response) active.lastResponse = { stopReason: response.stopReason, errorMessage: response.errorMessage };
		// A failed attempt may be retried. Publish its partial output silently,
		// but keep the Telegram turn active until pi is fully settled.
		if (response?.stopReason === "error" || response?.stopReason === "aborted") await preview.finalize();
	});

	pi.on("agent_settled", async () => {
		const turn = active;
		// Detach before awaiting Telegram I/O so messages arriving now start a new turn.
		active = undefined;
		currentAbort = undefined;
		stopTyping();
		if (pending) startTyping(pending.chatId);
		if (!turn) return;

		const { stopReason, errorMessage } = turn.lastResponse ?? {};
		const final = !turn.abortRequested && stopReason !== "aborted" && stopReason !== "error";
		const sent = await preview.finalize(final);
		if (turn.abortRequested || stopReason === "aborted") return;
		if (stopReason === "error") {
			await api.sendText(turn.chatId, errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}
		if (!sent && turn.queuedAttachments.length > 0) {
			await api.sendText(turn.chatId, "Attached requested file(s).");
		}
		await media.sendAttachments(turn.chatId, turn.queuedAttachments);
	});

	/** Dispatch a new batch of Telegram messages. Starts a fresh turn (if idle)
	 *  or steers into the running one. */
	async function handleIncoming(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const built = await build(messages);
		// Pi reports idle before settled handlers finish. A new Telegram message
		// in that window belongs to the next run, not the previous run's steering.
		const isFresh = !pending && (!active || ctx.isIdle());
		if (isFresh) {
			pending = built;
			startTyping(built.chatId);
		}
		pi.sendUserMessage(built.content, {
			expandPromptTemplates: true,
			...(isFresh ? {} : { deliverAs: "steer" }),
		});
	}

	/** Abort the active turn. Returns true iff one was active. */
	function abort(): boolean {
		if (currentAbort) {
			if (active) active.abortRequested = true;
			currentAbort();
			return true;
		}
		return false;
	}

	return { handleIncoming, abort };
}
