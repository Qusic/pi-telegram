import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { createPiProcessHarness } from "./support/pi-process.ts";

function userText(message: Message | undefined): string | undefined {
	if (message?.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

test("thinking and tool calls are rendered through a real pi tool loop", async (t) => {
	const readableFixture = fileURLToPath(new URL("fixtures/skills/fixture-skill/SKILL.md", import.meta.url));
	const missingFixture = `${readableFixture}.missing`;
	const harness = await createPiProcessHarness({
		responses: [
			{
				content: [
					{ type: "thinking", thinking: "checking command" },
					{ type: "text", text: "Running a command." },
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: readableFixture },
					},
					{
						type: "toolCall",
						id: "read-2",
						name: "read",
						arguments: { path: missingFixture },
					},
				],
				stopReason: "toolUse",
			},
			{ content: "Tool finished." },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("run a tool");
	const preamble = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.includes("checking command"),
	);
	const firstTool = await harness.telegram.waitForText(
		(message) => message.kind === "edit" && message.markdown.includes("FIXTURE_SKILL_MARKER"),
	);
	const failedTool = await harness.telegram.waitForText(
		(message) => message.kind === "edit" && message.markdown.startsWith("❌ **read**"),
	);
	await harness.telegram.waitForText((message) => message.kind === "message" && message.markdown === "Tool finished.");
	await harness.waitForIdle();
	const calls = await harness.getFauxCalls();

	assert.equal(calls.length, 2);
	assert.equal(preamble.markdown, "💭\nchecking command\n\n✏️\nRunning a command.");
	assert.match(firstTool.markdown, /^✅ \*\*read\*\*/);
	assert.match(failedTool.markdown, /SKILL\.md\.missing/);
	assert.equal(calls[0]?.reasoning, "high");
	const toolResults = calls[1]?.messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(
		toolResults?.map((message) => ({ toolName: message.toolName, isError: message.isError })),
		[
			{ toolName: "read", isError: false },
			{ toolName: "read", isError: true },
		],
	);
});

test("a Telegram message received while busy steers the active run", async (t) => {
	const firstReply = "first streamed answer ".repeat(6).trim();
	const harness = await createPiProcessHarness({
		tokensPerSecond: 40,
		responses: [{ content: firstReply }, { content: "answer after steering" }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("initial request");
	await harness.waitForFauxCalls(1);
	assert.equal((await harness.getState()).isStreaming, true);
	harness.telegram.receiveText("steer request");

	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === firstReply,
		10_000,
	);
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "answer after steering",
		10_000,
	);
	await harness.waitForIdle(10_000);
	const calls = await harness.getFauxCalls();

	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1]?.messages.filter((message) => message.role === "user").map(userText), [
		"initial request",
		"steer request",
	]);
});

test("/stop aborts an active stream and the next Telegram turn recovers", async (t) => {
	const harness = await createPiProcessHarness({
		tokensPerSecond: 20,
		responses: [{ content: "interrupted response ".repeat(10) }, { content: "recovered" }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	const sessionId = (await harness.getState()).sessionId;
	harness.telegram.receiveText("slow request");
	await harness.waitForFauxCalls(1);
	assert.equal((await harness.getState()).isStreaming, true);

	harness.telegram.receiveText("/new");
	await harness.telegram.waitForText(
		(message) =>
			message.kind === "message" && message.markdown === "Cannot start new session while pi is busy. Send /stop first.",
	);
	assert.equal((await harness.getState()).sessionId, sessionId);

	harness.telegram.receiveText("/stop");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Aborted current turn.",
	);
	await harness.waitForIdle();

	harness.telegram.receiveText("request after stop");
	await harness.telegram.waitForText((message) => message.kind === "message" && message.markdown === "recovered");
	await harness.waitForIdle();
	const calls = await harness.getFauxCalls();
	assert.equal(calls.length, 2);
	assert.equal(userText(calls[1]?.messages.at(-1)), "request after stop");
});

test("provider errors are reported to Telegram without becoming extension errors", async (t) => {
	const harness = await createPiProcessHarness({
		responses: [{ content: [], stopReason: "error", errorMessage: "scripted permanent failure" }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("failing request");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "scripted permanent failure",
	);
	await harness.waitForIdle();
	assert.equal((await harness.getFauxCalls()).length, 1);
});
