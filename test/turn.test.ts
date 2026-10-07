import assert from "node:assert/strict";
import { test } from "node:test";
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

	const intermediateReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === firstReply,
		10_000,
	);
	const finalReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "answer after steering",
		10_000,
	);
	await harness.waitForIdle(10_000);
	const calls = await harness.getFauxCalls();

	assert.equal(calls.length, 2);
	assert.equal(intermediateReply.silent, true);
	assert.equal(finalReply.silent, false);
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
	const stopReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Aborted current turn.",
	);
	await harness.waitForIdle();
	assert.equal(stopReply.silent, false);

	harness.telegram.receiveText("request after stop");
	await harness.telegram.waitForText((message) => message.kind === "message" && message.markdown === "recovered");
	await harness.waitForIdle();
	const calls = await harness.getFauxCalls();
	assert.equal(calls.length, 2);
	assert.equal(userText(calls[1]?.messages.at(-1)), "request after stop");
});

test("provider errors are reported to Telegram without becoming extension errors", async (t) => {
	const harness = await createPiProcessHarness({
		responses: [
			{
				content: "partial output before failure",
				stopReason: "error",
				errorMessage: "scripted permanent failure",
			},
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("failing request");
	const partialReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "partial output before failure",
	);
	const errorReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "scripted permanent failure",
	);
	await harness.waitForIdle();
	assert.equal(partialReply.silent, true);
	assert.equal(errorReply.silent, false);
	assert.equal((await harness.getFauxCalls()).length, 1);
});
