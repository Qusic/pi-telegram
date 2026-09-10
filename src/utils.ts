// Pure helpers.

import { extname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

export function isAssistantMessage(message: AgentMessage): boolean {
	return (message as unknown as { role?: string }).role === "assistant";
}

const SECTION_MARKER: Record<"text" | "thinking", string> = {
	text: "✏️\n",
	thinking: "💭\n",
};

function extractBlock(raw: unknown): { type: "text" | "thinking"; body: string } | undefined {
	if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
	const r = raw as { type: unknown; text?: unknown; thinking?: unknown };
	if (r.type === "text" && typeof r.text === "string") return { type: "text", body: r.text };
	if (r.type === "thinking" && typeof r.thinking === "string") return { type: "thinking", body: r.thinking };
}

/** Render an AgentMessage's content blocks to text. Thinking blocks are
 *  prefixed with 💭, text after thinking with ✏️, so the boundary is
 *  visible in chat. */
export function getMessageText(message: AgentMessage): string {
	const value = message as unknown as Record<string, unknown>;
	const content = Array.isArray(value.content) ? value.content : [];
	const parts: string[] = [];
	let prevType: "text" | "thinking" = "text";
	for (const raw of content) {
		const block = extractBlock(raw);
		if (!block) continue;
		const marker = block.type === prevType ? "" : SECTION_MARKER[block.type];
		parts.push(marker + block.body);
		prevType = block.type;
	}
	return parts.join("\n\n").trim();
}

/** Stop reason + error message from a turn's final assistant message. */
export function extractStopReason(messages: AgentMessage[]): { stopReason?: string; errorMessage?: string } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as unknown as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		return {
			stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
			errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
		};
	}
	return {};
}

/** Answer text (text blocks only, thinking excluded) of the most recent
 *  assistant message on a branch that produced any, or undefined. */
export function lastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !isAssistantMessage(entry.message)) continue;
		const text = answerText(entry.message);
		if (text) return text;
	}
	return undefined;
}

/** Like getMessageText, but answer-only — thinking blocks are dropped. */
function answerText(message: AgentMessage): string {
	const content = (message as unknown as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((raw) => {
			const block = extractBlock(raw);
			return block?.type === "text" ? [block.body] : [];
		})
		.join("\n\n")
		.trim();
}
