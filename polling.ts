// Long-poll loop against getUpdates, with media-group debouncing and
// authorization filtering. Self-registers session_start/shutdown handlers.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApiManager } from "./api.js";
import type { ConfigManager } from "./config.js";
import type { Dispatcher } from "./dispatch.js";
import type { TelegramMessage } from "./types.js";

const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

export interface PollingDeps {
	pi: ExtensionAPI;
	api: ApiManager;
	config: ConfigManager;
	dispatch: Dispatcher;
}

export function createPolling(deps: PollingDeps): void {
	const { pi, api, config, dispatch } = deps;

	let controller: AbortController | undefined;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();

	function stop(): void {
		controller?.abort();
		controller = undefined;
		// Don't await pollLoop — stop() may be called from inside its own call
		// stack (e.g. /new from Telegram triggers session_shutdown via pollLoop).
		// The aborted signal lets pollLoop exit on its next iteration.
		for (const group of mediaGroups.values()) {
			if (group.flushTimer) clearTimeout(group.flushTimer);
		}
		mediaGroups.clear();
	}

	function start(ctx: ExtensionContext): void {
		if (controller) return;
		controller = new AbortController();
		void pollLoop(ctx, controller.signal).finally(() => {
			controller = undefined;
		});
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (config.get().lastUpdateId === undefined) {
			try {
				const updates = await api.call<TelegramUpdate[]>(
					"getUpdates",
					{ offset: -1, limit: 1, timeout: 0 },
					{ signal },
				);
				const last = updates.at(-1);
				if (last) await config.update({ lastUpdateId: last.update_id });
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const lastSeen = config.get().lastUpdateId;
				const updates = await api.call<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: lastSeen !== undefined ? lastSeen + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					await config.update({ lastUpdateId: update.update_id });
					await handleUpdate(update, ctx);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				// Not aborted → no session swap in progress → ctx is still live.
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.setStatus("telegram", `⚠ ${message}`);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				ctx.ui.setStatus("telegram", undefined);
			}
		}
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		const cfg = config.get();
		if (cfg.allowedUserId === undefined) {
			// Bootstrap: report the user id so the operator can authorize it.
			ctx.ui.notify(
				`Telegram bridge: received message from user id ${message.from.id}. ` +
				`Add "allowedUserId": ${message.from.id} to ~/.pi/agent/telegram.json to authorize, then restart.`,
				"warning",
			);
			await api.sendText(message.chat.id, "Bot not configured: ask the operator to authorize your user id.");
			return;
		}

		if (message.from.id !== cfg.allowedUserId) {
			await api.sendText(message.chat.id, "This bot is not authorized for your account.");
			return;
		}

		// Albums arrive as separate updates with the same media_group_id; debounce.
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] as TelegramMessage[] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const group = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (group) void dispatch(group.messages, ctx);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatch([message], ctx);
	}

	// ---------- pi handler registration ----------

	pi.on("session_start", (_event, ctx) => {
		// botToken validity guaranteed by createConfig; allowedUserId may still
		// be missing — handleUpdate bootstraps it on first incoming message.
		start(ctx);
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		// Always abort: pi reloads the extension on every session swap, and a
		// lingering pollLoop would race with the new closure on getUpdates.
		stop();
	});
}
