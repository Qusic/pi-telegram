// Pure helpers.

import { extname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

export function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

export function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function isAssistantMessage(message: AgentMessage | undefined): message is AssistantMessage {
	return message?.role === "assistant";
}

const SECTION_MARKER: Record<"text" | "thinking", string> = {
	text: "✏️\n",
	thinking: "💭\n",
};

/** Render an assistant message's content blocks to text. Thinking blocks are
 *  prefixed with 💭, text after thinking with ✏️, so the boundary is
 *  visible in chat. */
export function getMessageText(message: AssistantMessage): string {
	const parts: string[] = [];
	let prevType: "text" | "thinking" = "text";
	for (const block of message.content) {
		if (block.type !== "text" && block.type !== "thinking") continue;
		const marker = block.type === prevType ? "" : SECTION_MARKER[block.type];
		parts.push(marker + (block.type === "text" ? block.text : block.thinking));
		prevType = block.type;
	}
	return parts.join("\n\n").trim();
}

/** Answer text (text blocks only, thinking excluded) of the most recent
 *  assistant message on a branch that produced any, or undefined. */
export function lastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || !isAssistantMessage(entry.message)) continue;
		const text = answerText(entry.message);
		if (text) return text;
	}
	return undefined;
}

/** Like getMessageText, but answer-only — thinking blocks are dropped. */
function answerText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
