// Download incoming attachments, build LLM prompt content from them, and
// send outgoing files queued by the telegram_attach tool.

import { readFile } from "node:fs/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ApiManager } from "./api.js";
import type { TelegramMessage } from "./types.js";
import { guessExtensionFromMime, guessMediaType, isImageMimeType } from "./utils.js";

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface DownloadedTelegramFile {
	path: string;
	isImage: boolean;
	mimeType?: string;
}

/** Outbound file queued by telegram_attach, sent on agent_end. */
export interface QueuedAttachment {
	path: string;
	fileName: string;
}

export type MediaManager = ReturnType<typeof createMedia>;

export function createMedia(api: ApiManager) {
	function collectFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const m of messages) {
			if (Array.isArray(m.photo) && m.photo.length > 0) {
				const photo = [...m.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) files.push({ file_id: photo.file_id, fileName: `photo-${m.message_id}.jpg`, mimeType: "image/jpeg", isImage: true });
			}
			if (m.document) files.push({
				file_id: m.document.file_id,
				fileName: m.document.file_name || `document-${m.message_id}${guessExtensionFromMime(m.document.mime_type, "")}`,
				mimeType: m.document.mime_type,
				isImage: isImageMimeType(m.document.mime_type),
			});
			if (m.video) files.push({
				file_id: m.video.file_id,
				fileName: m.video.file_name || `video-${m.message_id}${guessExtensionFromMime(m.video.mime_type, ".mp4")}`,
				mimeType: m.video.mime_type,
				isImage: false,
			});
			if (m.audio) files.push({
				file_id: m.audio.file_id,
				fileName: m.audio.file_name || `audio-${m.message_id}${guessExtensionFromMime(m.audio.mime_type, ".mp3")}`,
				mimeType: m.audio.mime_type,
				isImage: false,
			});
			if (m.voice) files.push({
				file_id: m.voice.file_id,
				fileName: `voice-${m.message_id}${guessExtensionFromMime(m.voice.mime_type, ".ogg")}`,
				mimeType: m.voice.mime_type,
				isImage: false,
			});
			if (m.animation) files.push({
				file_id: m.animation.file_id,
				fileName: m.animation.file_name || `animation-${m.message_id}${guessExtensionFromMime(m.animation.mime_type, ".mp4")}`,
				mimeType: m.animation.mime_type,
				isImage: false,
			});
			if (m.sticker) files.push({
				file_id: m.sticker.file_id,
				fileName: `sticker-${m.message_id}.webp`,
				mimeType: "image/webp",
				isImage: true,
			});
		}
		return files;
	}

	async function downloadFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectFileInfos(messages)) {
			const path = await api.download(file.file_id, file.fileName);
			downloaded.push({ path, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	/** Build LLM-bound prompt content: text + attachment paths + inline images. */
	async function buildPromptContent(messages: TelegramMessage[]): Promise<Array<TextContent | ImageContent>> {
		const rawText = messages.map((m) => (m.text || m.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await downloadFiles(messages);
		const content: Array<TextContent | ImageContent> = [];

		let prompt = rawText;
		if (files.length > 0) {
			if (prompt) prompt += "\n\n";
			prompt += "Attachments saved locally:";
			for (const file of files) prompt += `\n- ${file.path}`;
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({ type: "image", data: buffer.toString("base64"), mimeType: mediaType });
		}

		return content;
	}

	/** Send queued outbound files to the chat, with text fallback on failure. */
	async function sendAttachments(chatId: number, attachments: QueuedAttachment[]): Promise<void> {
		for (const att of attachments) {
			try {
				await api.sendAttachment(chatId, att.path, att.fileName);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await api.sendText(chatId, `Failed to send attachment ${att.fileName}: ${message}`);
			}
		}
	}

	return { buildPromptContent, sendAttachments };
}
