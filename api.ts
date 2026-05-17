// Telegram Bot API HTTP client.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigManager } from "./config.js";
import { mdToTelegramHtml } from "./render.js";
import { sanitizeFileName } from "./utils.js";

const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramGetFileResult {
	file_path: string;
}

/** Response shape for sendMessage / sendPhoto / sendDocument / editMessageText etc. */
export interface TelegramSentMessage {
	message_id: number;
}

export type TelegramParseMode = "HTML";

export class TelegramApiError extends Error {
	readonly code: number | undefined;
	readonly method: string;
	constructor(message: string, code: number | undefined, method: string) {
		super(message);
		this.code = code;
		this.method = method;
	}
}

export type ApiManager = ReturnType<typeof createApi>;

export function createApi(config: ConfigManager) {
	const baseUrl = `https://api.telegram.org/bot${config.get().botToken}/`;
	const fileBaseUrl = `https://api.telegram.org/file/bot${config.get().botToken}/`;

	async function call<T>(
		method: string,
		body: Record<string, unknown>,
		opts?: { signal?: AbortSignal },
	): Promise<T> {
		const response = await fetch(baseUrl + method, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: opts?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<T>;
		if (!data.ok || data.result === undefined) {
			throw new TelegramApiError(data.description || `Telegram API ${method} failed`, data.error_code, method);
		}
		return data.result;
	}

	async function callMultipart<T>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		opts?: { signal?: AbortSignal },
	): Promise<T> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.set(key, value);
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(baseUrl + method, {
			method: "POST",
			body: form,
			signal: opts?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<T>;
		if (!data.ok || data.result === undefined) {
			throw new TelegramApiError(data.description || `Telegram API ${method} failed`, data.error_code, method);
		}
		return data.result;
	}

	async function download(fileId: string, suggestedName: string): Promise<string> {
		const file = await call<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(fileBaseUrl + file.file_path);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	/** Send a short text message (caller ensures ≤ 4096 chars). Web page
	 *  previews are disabled — model output often contains URLs we don't want
	 *  ballooning into preview cards. */
	async function sendText(
		chatId: number,
		text: string,
		opts?: { parseMode?: TelegramParseMode },
	): Promise<void> {
		const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
		if (opts?.parseMode) body.parse_mode = opts.parseMode;
		await call<TelegramSentMessage>("sendMessage", body);
	}

	/** Render markdown → Telegram HTML and send. On a 400 (bad entities) fall
	 *  back to sending the ORIGINAL markdown as plain text — not the HTML,
	 *  which may exceed 4096 chars due to tag overhead. */
	async function sendRendered(chatId: number, markdown: string): Promise<void> {
		const html = mdToTelegramHtml(markdown);
		try {
			await sendText(chatId, html, { parseMode: "HTML" });
		} catch (err) {
			if (err instanceof TelegramApiError && err.code === 400) {
				await sendText(chatId, markdown);
				return;
			}
			throw err;
		}
	}

	return { call, callMultipart, download, sendText, sendRendered };
}
