// Turn lifecycle + pi event handlers (agent_*, message_*, tool_*): runs a
// prompt built from Telegram messages (prompt.ts) and mirrors pi's output back
// to the chat.
//
// A Telegram request can span multiple pi turns and retries: turn_end closes
// each tool batch, while agent_settled closes the Telegram request.
// Concurrency: no local queue. Idle → stash as `pending`, sendUserMessage,
// agent_start promotes to `active`. Busy → sendUserMessage with
// deliverAs:"steer" to inject into the running turn, adopting it if Telegram
// did not start it (e.g. a TUI prompt). Known gap: if another extension's
// input handler swallows the message, no run starts and `pending` waits for
// the next one.

import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createApi } from "./api.ts";
import { createPreview } from "./preview.ts";
import { createToolMessages } from "./toolcall.ts";
import { getMessageText, isAssistantMessage } from "./utils.ts";

interface TelegramTurn {
	chatId: number;
	lastResponse?: { stopReason: AssistantMessage["stopReason"]; errorMessage: string | undefined };
	abortRequested?: boolean;
}

interface TurnDeps {
	pi: ExtensionAPI;
	api: ReturnType<typeof createApi>;
}

export function createTurn(deps: TurnDeps) {
	const { pi, api } = deps;
	const preview = createPreview(api);
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

	// ---------- pi handler registration ----------

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
		await preview.finalize(final);
		if (stopReason === "error" && !turn.abortRequested) {
			await api.sendText(turn.chatId, errorMessage || "Telegram bridge: pi failed while processing the request.");
		}
	});

	/** Send a prompt from a Telegram chat to pi. Starts a fresh turn (if idle)
	 *  or steers into the running one. */
	function submit(chatId: number, prompt: Array<TextContent | ImageContent>, ctx: ExtensionContext): void {
		// Pi reports idle before settled handlers finish, so a message in that
		// window starts the next run rather than steering the settling one.
		const isFresh = !pending && ctx.isIdle();
		if (isFresh) pending = { chatId };
		else if (!pending) active ??= { chatId }; // adopt a run Telegram did not start, e.g. from the TUI
		startTyping(chatId);
		pi.sendUserMessage(prompt, {
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

	return { submit, abort };
}
