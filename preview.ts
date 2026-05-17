// Streaming preview / draft management.
//
// Caller pushes the full accumulated assistant text via update(); finalize()
// publishes whatever is buffered. When pendingText exceeds 4096, a head is
// promoted to a real message and the tail continues streaming as a draft.
//
// Invariant: fullText === publishedPrefix + pendingText.

import type { ApiManager } from "./api.js";

const PREVIEW_THROTTLE_MS = 750;
const MAX_MESSAGE_LENGTH = 4096;

interface TelegramPreviewState {
	chatId: number;
	publishedPrefix: string;
	pendingText: string;
	draftId?: number;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

export type PreviewManager = ReturnType<typeof createPreview>;

/** Pick a split point at or before maxLen, preferring paragraph > line > space.
 *  Falls back to a hard split at maxLen if no boundary exists in the second half. */
function findSplitPoint(text: string, maxLen: number): number {
	const minLen = Math.floor(maxLen / 2);
	let split = text.lastIndexOf("\n\n", maxLen);
	if (split >= minLen) return split + 2;
	split = text.lastIndexOf("\n", maxLen);
	if (split >= minLen) return split + 1;
	split = text.lastIndexOf(" ", maxLen);
	if (split >= minLen) return split + 1;
	return maxLen;
}

export function createPreview(api: ApiManager) {
	let current: TelegramPreviewState | undefined;

	async function deleteDraft(c: TelegramPreviewState): Promise<void> {
		if (c.draftId === undefined) return;
		try {
			await api.call("sendMessageDraft", { chat_id: c.chatId, draft_id: c.draftId, text: "" });
		} catch {
			// best-effort; drafts expire on Telegram's side
		}
		c.draftId = undefined;
	}

	/** Promote oversized pendingText into one or more real messages until it fits. */
	async function promoteOversized(c: TelegramPreviewState): Promise<void> {
		while (c.pendingText.length > MAX_MESSAGE_LENGTH) {
			const splitAt = findSplitPoint(c.pendingText, MAX_MESSAGE_LENGTH);
			const head = c.pendingText.slice(0, splitAt);
			await deleteDraft(c);
			await api.sendRendered(c.chatId, head);
			c.publishedPrefix += head;
			c.pendingText = c.pendingText.slice(splitAt);
			c.lastSentText = "";
		}
	}

	/** Replace pendingText with the latest tail and schedule a throttled flush. */
	function update(chatId: number, fullText: string): void {
		if (!current) {
			current = { chatId, publishedPrefix: "", pendingText: fullText, lastSentText: "" };
		} else {
			current.pendingText = fullText.slice(current.publishedPrefix.length);
		}
		if (!current.flushTimer) {
			current.flushTimer = setTimeout(() => { void flush(); }, PREVIEW_THROTTLE_MS);
		}
	}

	async function flush(): Promise<void> {
		const c = current;
		if (!c) return;
		if (c.flushTimer) {
			clearTimeout(c.flushTimer);
			c.flushTimer = undefined;
		}
		await promoteOversized(c);
		const text = c.pendingText.trim();
		if (!text || text === c.lastSentText) return;
		const draftId = c.draftId ?? Date.now();
		c.draftId = draftId;
		await api.call("sendMessageDraft", { chat_id: c.chatId, draft_id: draftId, text });
		c.lastSentText = text;
	}

	/** Publish any buffered text and reset. Returns true iff anything was
	 *  published over the preview's lifetime (including promoted chunks). */
	async function finalize(): Promise<boolean> {
		const c = current;
		if (!c) return false;
		if (c.flushTimer) {
			clearTimeout(c.flushTimer);
			c.flushTimer = undefined;
		}
		current = undefined;
		await promoteOversized(c);
		const text = c.pendingText.trim();
		await deleteDraft(c);
		if (!text) return c.publishedPrefix.length > 0;
		await api.sendRendered(c.chatId, text);
		return true;
	}

	return { update, finalize };
}
