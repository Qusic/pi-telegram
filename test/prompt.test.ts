import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPrompt } from "../src/prompt.ts";

test("buildPrompt lists downloaded files by local path and inlines only images", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-prompt-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	// Each "download" saves the file id as content, so inlined bytes show which file was used.
	const api = {
		async download(fileId: string, name: string) {
			const path = join(dir, name);
			await writeFile(path, fileId);
			return path;
		},
	};
	const chat = { id: 42, type: "private" };

	// An album: the caption rides on the first message.
	const prompt = await buildPrompt(api, [
		{
			message_id: 1,
			chat,
			caption: "  look at these  ",
			photo: [
				{ file_id: "photo-small", file_size: 10 },
				{ file_id: "photo-large", file_size: 90 },
			],
		},
		{ message_id: 2, chat, document: { file_id: "doc", file_name: "notes.pdf", mime_type: "application/pdf" } },
		{ message_id: 3, chat, voice: { file_id: "voice", mime_type: "audio/ogg" } },
	]);

	assert.deepEqual(prompt, [
		{
			type: "text",
			text: [
				"look at these",
				"",
				"Attachments saved locally:",
				`- ${join(dir, "photo-1.jpg")}`,
				`- ${join(dir, "notes.pdf")}`,
				`- ${join(dir, "voice-3.ogg")}`,
			].join("\n"),
		},
		{ type: "image", data: Buffer.from("photo-large").toString("base64"), mimeType: "image/jpeg" },
	]);
});
