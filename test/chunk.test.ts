import assert from "node:assert/strict";
import { test } from "node:test";
import { nextBoundary, renderChunk } from "../src/chunk.ts";

test("nextBoundary prefers a paragraph boundary within the budget", () => {
	const text = "first paragraph\n\nsecond paragraph that continues";
	assert.equal(nextBoundary(text, 0, 24), text.indexOf("second paragraph"));
});

test("renderChunk closes and reopens a fenced block split across messages", () => {
	const text = "```ts\nconst alpha = 1;\nconst beta = 2;\n```";
	const split = text.indexOf("const beta");

	assert.equal(renderChunk(text, 0, split), "```ts\nconst alpha = 1;\n```");
	assert.equal(renderChunk(text, split, text.length), "```ts\nconst beta = 2;\n```");
});
