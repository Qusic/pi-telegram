// Turn lifecycle + pi event handlers (agent_*, message_*, tool_*). Registers
// the telegram_attach tool. Media handling lives in media.ts.
//
// Concurrency: no local queue. Idle → stash as `pending`, sendUserMessage,
// agent_start promotes to `active`. Busy → sendUserMessage with
// deliverAs:"steer" to inject into the running turn.

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ApiManager } from "./api.js";
import type { MediaManager, QueuedAttachment } from "./media.js";
import type { PreviewManager } from "./preview.js";
import { type ResultBlock, type ToolArgs, renderToolEnd, renderToolStart } from "./toolcall.js";
import type { TelegramMessage } from "./types.js";
import { extractStopReason, getMessageText, isAssistantMessage } from "./utils.js";

const MAX_ATTACHMENTS_PER_TURN = 10;

interface TelegramTurn {
	chatId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
}

export type TurnManager = ReturnType<typeof createTurn>;

export interface TurnDeps {
	pi: ExtensionAPI;
	api: ApiManager;
	media: MediaManager;
	preview: PreviewManager;
}

export function createTurn(deps: TurnDeps) {
	const { pi, api, media, preview } = deps;

	let pending: TelegramTurn | undefined;
	let active: TelegramTurn | undefined;
	let currentAbort: (() => void) | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	// toolCallId → its breadcrumb message id and the args from tool_execution_start
	// (the end event omits args, so we stash them to re-render the finished card).
	const toolMessages = new Map<string, { id: number; toolName: string; args: ToolArgs }>();

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
		typingInterval = setInterval(() => { void sendTyping(); }, 4000);
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
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
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
		await preview.finalize();
		pending = undefined;
		active = undefined;
		currentAbort = undefined;
		toolMessages.clear();
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
		// Finalize first so pre-tool text doesn't end up below the 🔧 message.
		await preview.finalize();
		const args = event.args as ToolArgs;
		const sent = await api.sendText(active.chatId, renderToolStart(event.toolName, args));
		toolMessages.set(event.toolCallId, { id: sent.message_id, toolName: event.toolName, args });
	});

	pi.on("tool_execution_end", async (event) => {
		if (!active) return;
		const entry = toolMessages.get(event.toolCallId);
		toolMessages.delete(event.toolCallId);
		if (!entry) return;
		const blocks = (Array.isArray(event.result?.content) ? event.result.content : []) as ResultBlock[];
		const text = renderToolEnd(entry.toolName, entry.args, blocks, event.isError);
		await api.editText(active.chatId, entry.id, text).catch(() => {});
	});

	pi.on("agent_end", async (event, _ctx) => {
		const turn = active;
		currentAbort = undefined;
		stopTyping();
		active = undefined;
		pending = undefined;
		// Drop any breadcrumbs whose tool never reported an end (e.g. aborted mid-run).
		toolMessages.clear();
		if (!turn) return;

		const { stopReason, errorMessage } = extractStopReason(event.messages);
		// Always publish whatever streamed so far, then branch on the outcome.
		const sent = await preview.finalize();
		if (stopReason === "aborted") return;
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
	async function handleIncoming(messages: TelegramMessage[], _ctx: ExtensionContext): Promise<void> {
		const built = await build(messages);
		const isFresh = !pending && !active;
		if (isFresh) {
			pending = built;
			startTyping(built.chatId);
		}
		// expandSkills is only honored by a locally patched pi; upstream pi ignores
		// it (skills are discovered by the LLM on its own).
		pi.sendUserMessage(
			built.content,
			{ expandSkills: true, ...(isFresh ? {} : { deliverAs: "steer" }) } as any,
		);
	}

	/** Abort the active turn. Returns true iff one was active. */
	function abort(): boolean {
		if (currentAbort) {
			currentAbort();
			return true;
		}
		return false;
	}

	return { handleIncoming, abort };
}
