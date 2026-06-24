// Streaming preview / draft management.
//
// Caller pushes the full accumulated assistant text via update(); finalize()
// publishes whatever is buffered. When the pending tail exceeds the per-message
// budget, a head is promoted to a real message and the rest keeps streaming as
// a draft; chunk.ts picks block-aware cut points so each piece stays valid
// markdown (code fences split across messages are reopened/closed).
//
// Concurrency: update() is synchronous and only ever GROWS `fullText`
// (assistant output is append-only). All async work (draft sends, promotions,
// finalize) runs through a single serialized `enqueue` chain so two operations
// can never mutate the same state concurrently — that race was the source of
// duplicated commits and dropped tails on long outputs. Because update() is
// append-only, every serialized task re-derives the pending region from
// `publishedChars` at point-of-use, so an update() landing between awaits can
// never corrupt the invariant.

import { type ApiManager, MAX_MESSAGE_LENGTH } from "./api.js";
import { nextBoundary, renderChunk } from "./chunk.js";

const PREVIEW_THROTTLE_MS = 1500;

// Headroom for the fence reopen/close markers renderChunk may add to a chunk
// (```lang … ```): at most a couple of fence runs plus a language token.
const CHUNK_BUDGET = MAX_MESSAGE_LENGTH - 64;

interface TelegramPreviewState {
	chatId: number;
	/** Entire accumulated assistant text seen so far (monotonically grows). */
	fullText: string;
	/** Raw chars of `fullText` already committed as real messages (a true prefix
	 *  offset — synthetic fences are render-only and never counted here). */
	publishedChars: number;
	/** Last text pushed to the live draft (dedup guard). */
	lastSentText: string;
	/** True once anything has been committed as a real message. */
	published: boolean;
	draftId?: number;
	flushTimer?: ReturnType<typeof setTimeout>;
}

export type PreviewManager = ReturnType<typeof createPreview>;

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

	/** Render the uncommitted region [publishedChars, to) as a standalone message. */
	function renderPending(c: TelegramPreviewState, to: number): string {
		return renderChunk(c.fullText, c.publishedChars, to);
	}

	async function clearDraft(c: TelegramPreviewState): Promise<void> {
		if (c.draftId === undefined) return;
		await api.clearDraft(c.chatId, c.draftId);
		c.draftId = undefined;
	}

	/** Promote oversized pending text into one or more real messages until it
	 *  fits. Re-reads `fullText` each iteration so a concurrent update() (which
	 *  only appends) is absorbed safely. */
	async function promoteOversized(c: TelegramPreviewState): Promise<void> {
		while (c.fullText.length - c.publishedChars > CHUNK_BUDGET) {
			const to = nextBoundary(c.fullText, c.publishedChars, CHUNK_BUDGET);
			const head = renderPending(c, to);
			await clearDraft(c);
			await api.sendText(c.chatId, head);
			c.publishedChars = to;
			c.published = true;
			c.lastSentText = "";
		}
	}

	/** Replace the accumulated text and schedule a throttled flush. */
	function update(chatId: number, fullText: string): void {
		if (!current || current.chatId !== chatId) {
			current = { chatId, fullText, publishedChars: 0, lastSentText: "", published: false };
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
		const draft = renderPending(c, c.fullText.length);
		if (!draft || draft === c.lastSentText) return;
		const draftId = c.draftId ?? Date.now();
		c.draftId = draftId;
		await api.sendDraft(c.chatId, draftId, draft);
		c.lastSentText = draft;
	}

	async function finalizeState(c: TelegramPreviewState): Promise<boolean> {
		await promoteOversized(c);
		const text = renderPending(c, c.fullText.length);
		await clearDraft(c);
		if (!text) return c.published;
		await api.sendText(c.chatId, text);
		c.publishedChars = c.fullText.length;
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
