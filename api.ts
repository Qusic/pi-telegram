// Telegram Bot API HTTP client.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigManager } from "./config.js";
import { mdToTelegramHtml } from "./render.js";
import { guessMediaType, sanitizeFileName } from "./utils.js";

const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");

/** Telegram's hard limit on a single message's text length. */
export const MAX_MESSAGE_LENGTH = 4096;

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number };
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortError());
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface TelegramGetFileResult {
	file_path: string;
}

/** Response shape for sendMessage / sendPhoto / sendDocument / editMessageText etc. */
export interface TelegramSentMessage {
	message_id: number;
}

type TelegramParseMode = "HTML";

class TelegramApiError extends Error {
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

	// POST to the Bot API with shared retry on 429 / 5xx / network errors.
	// Pass a plain object for the common JSON call, or a request factory
	// (re-invoked per attempt — a consumed body can't be replayed) for non-JSON
	// calls like multipart uploads.
	//
	// Telegram per-chat rate limits (HTTP 429) are routine when streaming long
	// answers (each promoted chunk + draft is a separate request); retrying them
	// — and transient 5xx / network blips — keeps a rejection from stalling the
	// live draft and dropping the final message.
	async function call<T>(
		method: string,
		body: Record<string, unknown> | (() => Promise<Response>),
		opts?: { signal?: AbortSignal },
	): Promise<T> {
		const signal = opts?.signal;
		const makeRequest = typeof body === "function"
			? body
			: () => fetch(baseUrl + method, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});

		const MAX_RETRIES = 5;
		const MAX_BACKOFF_MS = 15_000;
		// Exponential backoff (capped) for retry attempt `n` (0-based).
		const backoff = (n: number) => Math.min(2 ** n * 500, MAX_BACKOFF_MS);
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await makeRequest();
			} catch (err) {
				// Network error: retry unless aborted or out of attempts.
				if (signal?.aborted || attempt >= MAX_RETRIES) throw err;
				await delay(backoff(attempt), signal);
				continue;
			}
			const data = (await response.json()) as TelegramApiResponse<T>;
			if (data.ok && data.result !== undefined) return data.result;

			const code = data.error_code;
			const retriable = code === 429 || (code !== undefined && code >= 500);
			if (retriable && !signal?.aborted && attempt < MAX_RETRIES) {
				const retryAfter = data.parameters?.retry_after;
				await delay(retryAfter !== undefined ? retryAfter * 1000 + 250 : backoff(attempt), signal);
				continue;
			}
			throw new TelegramApiError(data.description || `Telegram API ${method} failed`, code, method);
		}
	}

	async function callMultipart<T>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		opts?: { signal?: AbortSignal },
	): Promise<T> {
		// Read once; rebuild the FormData per attempt (a consumed body can't be reused).
		const blob = new Blob([await readFile(filePath)]);
		return call<T>(method, () => {
			const form = new FormData();
			for (const [key, value] of Object.entries(fields)) form.set(key, value);
			form.set(fileField, blob, fileName);
			return fetch(baseUrl + method, { method: "POST", body: form, signal: opts?.signal });
		}, opts);
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

	type TextOpts = { parseMode?: TelegramParseMode; disableWebPagePreview?: boolean };

	/** Shared body for sendMessage / editMessageText. Link previews are disabled
	 *  by default — model output often contains URLs we don't want ballooning
	 *  into preview cards; pass `disableWebPagePreview: false` to opt back in. */
	function textBody(text: string, opts?: TextOpts): Record<string, unknown> {
		const body: Record<string, unknown> = {
			text,
			link_preview_options: { is_disabled: opts?.disableWebPagePreview ?? true },
		};
		if (opts?.parseMode) body.parse_mode = opts.parseMode;
		return body;
	}

	/** Send a short text message (caller ensures ≤ MAX_MESSAGE_LENGTH chars). */
	async function sendText(chatId: number, text: string, opts?: TextOpts): Promise<TelegramSentMessage> {
		return await call<TelegramSentMessage>("sendMessage", { chat_id: chatId, ...textBody(text, opts) });
	}

	/** Edit a previously-sent text message (caller ensures ≤ MAX_MESSAGE_LENGTH chars). */
	async function editText(chatId: number, messageId: number, text: string, opts?: TextOpts): Promise<void> {
		await call("editMessageText", { chat_id: chatId, message_id: messageId, ...textBody(text, opts) });
	}

	/** Render markdown → Telegram HTML and send. On a 400 (bad entities) fall
	 *  back to sending the ORIGINAL markdown as plain text — not the HTML,
	 *  which may exceed MAX_MESSAGE_LENGTH due to tag overhead. */
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

	/** Upload a local file as photo (if recognised image mime) or generic document. */
	async function sendAttachment(
		chatId: number,
		filePath: string,
		fileName: string,
	): Promise<TelegramSentMessage> {
		const mediaType = guessMediaType(filePath);
		const method = mediaType ? "sendPhoto" : "sendDocument";
		const fieldName = mediaType ? "photo" : "document";
		return await callMultipart<TelegramSentMessage>(
			method,
			{ chat_id: String(chatId) },
			fieldName,
			filePath,
			fileName,
		);
	}

	return { call, download, sendText, editText, sendRendered, sendAttachment };
}
