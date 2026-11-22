// The attach tool: sends a local file to the authorized user's DM (a DM's chat
// id is the user id) as soon as it is called, from Telegram or the TUI alike.

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { createApi } from "./api.ts";
import type { createConfig } from "./config.ts";

interface AttachDeps {
	pi: ExtensionAPI;
	api: ReturnType<typeof createApi>;
	config: Awaited<ReturnType<typeof createConfig>>;
}

export function createAttach(deps: AttachDeps): void {
	const { pi, api, config } = deps;
	// Config is read once per load: without an authorized user, never offer it.
	const chatId = config.get().allowedUserId;
	if (chatId === undefined) return;

	pi.registerTool({
		name: "attach",
		label: "Attach",
		description: "Send a local file to the user as an attachment.",
		promptSnippet: "Send a local file to the user as an attachment",
		parameters: Type.Object({
			path: Type.String({ description: "Local file path" }),
		}),
		// One file per call; several calls run in order so files arrive as listed.
		executionMode: "sequential",
		async execute(_toolCallId, { path }, signal, _onUpdate, ctx) {
			// Like the built-in tools: drop a leading "@" and resolve against the session cwd.
			await api.sendAttachment(chatId, resolve(ctx.cwd, path.replace(/^@/, "")), { signal });
			return { content: [{ type: "text", text: "Sent the file to the user." }], details: undefined };
		},
	});
}
