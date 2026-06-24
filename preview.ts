// Streaming preview / draft management.
//
// Caller pushes the full accumulated assistant text via update(); finalize()
// publishes whatever is buffered. Streaming uses the native Rich Message API
// (sendRichMessageDraft → sendRichMessage), so previews and final messages
// render full GitHub-Flavored Markdown. When the buffered tail exceeds the
// rich-message budget, a head is promoted to a real message and the remainder
// keeps streaming as a draft.
//
// Concurrency: update() is synchronous and only ever GROWS `fullText`
// (assistant output is append-only). All async work (draft sends, promotions,
// finalize) runs through a single serialized `enqueue` chain so two operations
// can never mutate the same state concurrently — that race was the source of
// duplicated commits and dropped tails on long outputs. Because update() is
// append-only, every serialized task re-derives the pending tail from
// `fullText.slice(publishedPrefix.length)` at point-of-use, so an update()
// landing between awaits can never corrupt the invariant.

import { type ApiManager, MAX_MESSAGE_LENGTH } from "./api.js";

const PREVIEW_THROTTLE_MS = 1500;

interface TelegramPreviewState {
	chatId: number;
	/** Entire accumulated assistant text seen so far (monotonically grows). */
	fullText: string;
	/** Prefix already committed as real messages. */
	publishedPrefix: string;
	/** Last text pushed to the live draft (dedup guard). */
	lastSentText: string;
	/** True once anything has been committed as a real message. */
	published: boolean;
	draftId?: number;
	flushTimer?: ReturnType<typeof setTimeout>;
}

export type PreviewManager = ReturnType<typeof createPreview>;

/** Pick a split point at or before maxLen, preferring paragraph > line > space.
 *  Falls back to a hard split at maxLen if no boundary exists in the second half.
 *  TODO: make this block-aware (don't split inside a ``` fence) so promoted
 *  heads/tails render cleanly. */
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

	// Single-writer queue: every async preview op runs strictly one at a time,
	// in FIFO order, so flush/promote/finalize never overlap. A failed task
	// never poisons the chain (its rejection is swallowed for chain purposes
	// but still surfaced to the original caller).
	let chain: Promise<unknown> = Promise.resolve();
	function enqueue<T>(task: () => Promise<T>): Promise<T> {
		// `chain` is kept non-rejecting (the .catch below), so a plain .then runs
		// tasks strictly one at a time, in FIFO order.
		const next = chain.then(task);
		chain = next.catch(() => {});
		return next;
	}

	function pendingTail(c: TelegramPreviewState): string {
		return c.fullText.slice(c.publishedPrefix.length);
	}

	async function clearDraft(c: TelegramPreviewState): Promise<void> {
		if (c.draftId === undefined) return;
		await api.clearDraft(c.chatId, c.draftId);
		c.draftId = undefined;
	}

	/** Promote the oversized tail into one or more real messages until it fits.
	 *  Re-derives the tail from `fullText` each iteration so a concurrent
	 *  update() (which only appends) is absorbed safely. */
	async function promoteOversized(c: TelegramPreviewState): Promise<void> {
		let tail = pendingTail(c);
		while (tail.length > MAX_MESSAGE_LENGTH) {
			const splitAt = findSplitPoint(tail, MAX_MESSAGE_LENGTH);
			const head = tail.slice(0, splitAt);
			await clearDraft(c);
			await api.sendText(c.chatId, head);
			c.publishedPrefix += head;
			c.published = true;
			c.lastSentText = "";
			tail = pendingTail(c);
		}
	}

	/** Replace the accumulated text and schedule a throttled flush. */
	function update(chatId: number, fullText: string): void {
		if (!current || current.chatId !== chatId) {
			current = { chatId, fullText, publishedPrefix: "", lastSentText: "", published: false };
		} else {
			current.fullText = fullText;
		}
		const c = current;
		if (!c.flushTimer) {
			c.flushTimer = setTimeout(() => {
				c.flushTimer = undefined;
				// Skip if this state was already finalized/replaced.
				void enqueue(() => (current === c ? flushState(c) : Promise.resolve())).catch(() => {});
			}, PREVIEW_THROTTLE_MS);
		}
	}

	async function flushState(c: TelegramPreviewState): Promise<void> {
		await promoteOversized(c);
		const text = pendingTail(c).trim();
		if (!text || text === c.lastSentText) return;
		const draftId = c.draftId ?? Date.now();
		c.draftId = draftId;
		await api.sendDraft(c.chatId, draftId, text);
		c.lastSentText = text;
	}

	async function finalizeState(c: TelegramPreviewState): Promise<boolean> {
		await promoteOversized(c);
		const text = pendingTail(c).trim();
		await clearDraft(c);
		if (!text) return c.published;
		await api.sendText(c.chatId, text);
		c.publishedPrefix = c.fullText;
		c.published = true;
		return true;
	}

	/** Publish any buffered text and reset. Returns true iff anything was
	 *  committed as a real message over the preview's lifetime. Never rejects —
	 *  a transient send failure must not break the turn lifecycle. */
	function finalize(): Promise<boolean> {
		const c = current;
		if (!c) return Promise.resolve(false);
		if (c.flushTimer) {
			clearTimeout(c.flushTimer);
			c.flushTimer = undefined;
		}
		// Detach synchronously so any queued flush for this state no-ops and a
		// subsequent assistant message starts a fresh preview.
		current = undefined;
		return enqueue(() => finalizeState(c)).catch(() => c.published);
	}

	return { update, finalize };
}
