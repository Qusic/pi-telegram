import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createPiProcessHarness } from "./support/pi-process.ts";

async function writeFixtureFile(t: TestContext, name: string, content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-attach-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, name);
	await writeFile(path, content);
	return path;
}

/** One assistant message calling attach once per path. */
function attachCalls(...paths: string[]) {
	return {
		content: paths.map((path, i) => ({
			type: "toolCall" as const,
			id: `attach-${i + 1}`,
			name: "attach",
			arguments: { path },
		})),
		stopReason: "toolUse" as const,
	};
}

function toolResults(messages: Message[] = []) {
	return messages
		.filter((message) => message.role === "toolResult")
		.map(({ isError, content }) => ({
			isError,
			text: content.map((block) => (block.type === "text" ? block.text : "")).join(""),
		}));
}

test("attach sends each file to the authorized chat in call order", async (t) => {
	const second = await writeFixtureFile(t, "second.txt", "SECOND");
	const harness = await createPiProcessHarness({
		// The first path is relative to the session cwd and carries the "@" some models prepend.
		responses: [attachCalls("@first.txt", second), { content: "Sent both files." }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});
	await writeFile(join(harness.cwd, "first.txt"), "FIRST");

	// Prompted directly (like the TUI), not through Telegram.
	await harness.prompt("send both files to me");
	const [call, followUp] = await harness.waitForFauxCalls(2);
	await harness.waitForIdle();

	// Listed like any other tool: one neutral line, no rules nudging the model to use it.
	const promptLines = getCurrentSystemPrompt(call?.messages ?? []).split("\n");
	assert.deepEqual(
		promptLines.filter((line) => line.includes("attach")),
		["- attach: Send a local file to the user as an attachment"],
	);
	assert.deepEqual(harness.telegram.getAttachments(), [
		{ method: "sendDocument", chatId: 42, fileName: "first.txt", content: "FIRST" },
		{ method: "sendDocument", chatId: 42, fileName: "second.txt", content: "SECOND" },
	]);
	assert.deepEqual(toolResults(followUp?.messages), [
		{ isError: false, text: "Sent the file to the user." },
		{ isError: false, text: "Sent the file to the user." },
	]);
	// A run that did not come from Telegram is not mirrored there; only the files are sent.
	assert.deepEqual(harness.telegram.getMessages(), []);
});

test("attach is not offered until an authorized user is configured", async (t) => {
	const harness = await createPiProcessHarness({
		telegramConfig: { lastUpdateId: 0 },
		responses: [{ content: "ok" }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	await harness.prompt("hello");
	const [call] = await harness.waitForFauxCalls(1);
	await harness.waitForIdle();

	const toolNames = getCurrentTools(call?.messages ?? []).map((tool) => tool.name);
	assert.ok(toolNames.includes("read"), "the tool list itself is present");
	assert.ok(!toolNames.includes("attach"));
});
