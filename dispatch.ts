// Routes incoming Telegram messages: built-in slash commands first, then
// fall through to the agent as a regular turn.
//
// /new and /resume <n> need ctx.newSession() / switchSession(), which only
// exist on ExtensionCommandContext. dispatch's ctx is a regular
// ExtensionContext (event handler), so we stash a closure in `pendingAction`
// and fire `/telegram-execute-action` to bounce through a registered command
// handler whose ctx has the right type.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ApiManager } from "./api.js";
import type { TurnManager } from "./turn.js";
import type { TelegramMessage } from "./types.js";
import { formatTokens } from "./utils.js";

export type Dispatcher = (messages: TelegramMessage[], ctx: ExtensionContext) => Promise<void>;

type PendingTelegramAction = (ctx: ExtensionCommandContext) => Promise<void>;

/** Commands published to the Telegram bot menu at boot. */
const BOT_COMMANDS = [
	{ command: "new",     description: "Start a new session" },
	{ command: "resume",  description: "List or resume sessions: /resume [n]" },
	{ command: "stop",    description: "Abort current turn" },
	{ command: "status",  description: "Show usage info" },
	{ command: "compact", description: "Compact conversation" },
	{ command: "skills",  description: "List available skills" },
];

export interface DispatcherDeps {
	pi: ExtensionAPI;
	api: ApiManager;
	turn: TurnManager;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
	const { pi, api, turn } = deps;

	// Cache last /resume listing for index lookup; per-closure (cleared on session swap).
	let lastList: SessionInfo[] | undefined;

	// Closure queued by /new or /resume <n>, drained by /telegram-execute-action.
	let pendingAction: PendingTelegramAction | undefined;

	pi.registerCommand("telegram-execute-action", {
		description: "(internal) execute a queued Telegram-initiated session action",
		handler: async (_args, ctx) => {
			const action = pendingAction;
			pendingAction = undefined;
			if (action) await action(ctx);
		},
	});

	/** Bounce through a registered command so the handler gets an
	 *  ExtensionCommandContext (with newSession/switchSession). expandSkills
	 *  is required to route extension commands — only supported on a locally
	 *  patched pi; upstream pi ignores the option (and relies on the LLM to
	 *  discover skills on its own). */
	function trampoline(action: PendingTelegramAction): void {
		pendingAction = action;
		pi.sendUserMessage("/telegram-execute-action", { expandSkills: true } as any);
	}

	// Publish the bot menu once. Telegram persists this server-side; a network
	// blip just leaves the previous menu in place.
	void api.call("setMyCommands", { commands: BOT_COMMANDS }).catch(() => {});

	return async function dispatch(messages, ctx) {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((m) => (m.text || m.caption || "").trim()).find((t) => t.length > 0) || "";
		const lower = rawText.toLowerCase();
		const reply = (text: string) => api.sendText(firstMessage.chat.id, text);
		const requireIdle = async (action: string): Promise<boolean> => {
			if (ctx.isIdle()) return true;
			await reply(`Cannot ${action} while pi is busy. Send "stop" first.`);
			return false;
		};

		if (lower === "/new") {
			if (!await requireIdle("start new session")) return;
			trampoline(async (cmdCtx) => {
				const result = await cmdCtx.newSession();
				await reply(result.cancelled ? "New session cancelled." : "\u2713 New session started.");
			});
			return;
		}

		if (lower === "/resume") {
			const cwd = ctx.sessionManager.getCwd();
			const all = await SessionManager.list(cwd);
			const currentFile = ctx.sessionManager.getSessionFile();
			lastList = all.slice(0, 20);
			if (lastList.length === 0) {
				await reply("No sessions found.");
				return;
			}
			const lines = lastList.map((s, i) => {
				const marker = s.path === currentFile ? "\u25cf " : "  ";
				const date = s.modified.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
				const title = (s.name || s.firstMessage).replace(/\s+/g, " ").slice(0, 60);
				return `${marker}/resume${i + 1} [${date}] ${title} (${s.messageCount})`;
			});
			lines.unshift("Sessions (tap to resume):");
			await reply(lines.join("\n"));
			return;
		}

		const resumeMatch = lower.match(/^\/resume\s*(\d+)$/);
		if (resumeMatch) {
			if (!await requireIdle("resume")) return;
			const idx = parseInt(resumeMatch[1], 10) - 1;
			if (!lastList || idx < 0 || idx >= lastList.length) {
				await reply("Invalid index. Run /resume to list sessions first.");
				return;
			}
			const target = lastList[idx];
			const label = (target.name || target.firstMessage).replace(/\s+/g, " ").slice(0, 80);
			trampoline(async (cmdCtx) => {
				const result = await cmdCtx.switchSession(target.path);
				await reply(result.cancelled ? "Resume cancelled." : `\u2713 Resumed: ${label}`);
			});
			return;
		}

		if (lower === "/stop") {
			const hadActive = turn.abort();
			await reply(hadActive ? "Aborted current turn." : "No active turn.");
			return;
		}

		if (lower === "/status") {
			await reply(buildStatusReport(ctx));
			return;
		}

		if (lower === "/compact") {
			if (!await requireIdle("compact")) return;
			ctx.compact({
				onComplete: () => { void reply("Compaction completed."); },
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void reply(`Compaction failed: ${message}`);
				},
			});
			await reply("Compaction started.");
			return;
		}

		if (lower === "/skills") {
			const skills = pi.getCommands()
				.filter((cmd) => cmd.source === "skill")
				.map((cmd) => `/${cmd.name} \u2014 ${cmd.description || "no description"}`);
			await reply(skills.length > 0 ? skills.join("\n") : "No skills available.");
			return;
		}

		// Default: forward as a regular agent turn.
		await turn.handleIncoming(messages, ctx);
	};
}

function buildStatusReport(ctx: ExtensionContext): string {
	let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		totalInput += entry.message.usage.input;
		totalOutput += entry.message.usage.output;
		totalCacheRead += entry.message.usage.cacheRead;
		totalCacheWrite += entry.message.usage.cacheWrite;
		totalCost += entry.message.usage.cost.total;
	}
	const usage = ctx.getContextUsage();
	const lines: string[] = [];
	if (ctx.model) lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
	const tokenParts: string[] = [];
	if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
	if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
	if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
	if (tokenParts.length > 0) lines.push(`Usage: ${tokenParts.join(" ")}`);
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (totalCost || usingSubscription) lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	if (usage) {
		const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
		lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
	} else {
		lines.push("Context: unknown");
	}
	return lines.length === 0 ? "No usage data yet." : lines.join("\n");
}
