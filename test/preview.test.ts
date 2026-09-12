import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MESSAGE_LENGTH } from "../src/api.ts";
import { createPreview } from "../src/preview.ts";

interface SentText {
	markdown: string;
	silent: boolean;
}

test("oversized preview chunks are silent and only the final tail notifies", async () => {
	const sent: SentText[] = [];
	const api: Parameters<typeof createPreview>[0] = {
		sendText: async (_chatId, markdown, options) => {
			sent.push({ markdown, silent: options?.silent === true });
			return { message_id: sent.length };
		},
		sendDraft: async () => {},
		clearDraft: async () => {},
	};
	const preview = createPreview(api);
	const answer = `${"x".repeat(MAX_MESSAGE_LENGTH)}\nfinal tail`;

	preview.update(100, answer);
	assert.equal(await preview.finalize(true), true);

	assert.equal(sent.length, 2);
	assert.deepEqual(
		sent.map((message) => message.silent),
		[true, false],
	);
	assert.ok(sent.every((message) => message.markdown.length > 0 && message.markdown.length <= MAX_MESSAGE_LENGTH));
	assert.match(sent[1]?.markdown ?? "", /final tail$/);
	assert.equal(sent.map((message) => message.markdown).join(""), answer);
});
