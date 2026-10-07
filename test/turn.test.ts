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

test("a transient provider failure reports only the successful retry", async (t) => {
	const harness = await createPiProcessHarness({
		retrySettings: { maxRetries: 1, baseDelayMs: 20 },
		responses: [
			{ content: "partial failed attempt", stopReason: "error", errorMessage: "503 retryable failure" },
			{ content: "recovered after retry" },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("request with a transient failure");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "recovered after retry",
	);
	await harness.waitForAgentSettled(1);
	assert.equal((await harness.getFauxCalls()).length, 2);
	assert.deepEqual(
		harness.telegram.getMessages().map(({ markdown, silent }) => ({ markdown, silent })),
		[
			{ markdown: "partial failed attempt", silent: true },
			{ markdown: "recovered after retry", silent: false },
		],
	);
});

test("a message arriving during agent_settled starts a new Telegram turn", async (t) => {
	const harness = await createPiProcessHarness({
		pauseFirstSettlement: true,
		responses: [{ content: "first settled reply" }, { content: "second settled reply" }],
	});
	t.after(async () => {
		await harness.releaseSettlement();
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("first settled request");
	await harness.waitForSettlementPause();
	assert.equal(harness.telegram.getMessages().length, 0);
	const secondId = harness.telegram.receiveText("second settled request");
	await harness.telegram.waitForUpdateConsumed(secondId);
	assert.equal(harness.telegram.getMessages().length, 0);
	await harness.releaseSettlement();
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "second settled reply",
	);
	await harness.waitForAgentSettled(2);
	assert.deepEqual(
		harness.telegram.getMessages().map(({ markdown, silent }) => ({ markdown, silent })),
		[
			{ markdown: "first settled reply", silent: false },
			{ markdown: "second settled reply", silent: false },
		],
	);
	assert.equal((await harness.getFauxCalls()).length, 2);
});

test("exhausted retries notify only the final provider error", async (t) => {
	const harness = await createPiProcessHarness({
		retrySettings: { maxRetries: 1, baseDelayMs: 20 },
		responses: [
			{ content: "partial attempt one", stopReason: "error", errorMessage: "503 first failure" },
			{ content: "partial attempt two", stopReason: "error", errorMessage: "503 final failure" },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("request that exhausts retries");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "503 final failure",
	);
	await harness.waitForAgentSettled(1);
	assert.equal((await harness.getFauxCalls()).length, 2);
	assert.deepEqual(
		harness.telegram.getMessages().map(({ markdown, silent }) => ({ markdown, silent })),
		[
			{ markdown: "partial attempt one", silent: true },
			{ markdown: "partial attempt two", silent: true },
			{ markdown: "503 final failure", silent: false },
		],
	);
});

test("/stop during retry backoff does not report the prior provider error", async (t) => {
	const harness = await createPiProcessHarness({
		retrySettings: { maxRetries: 1, baseDelayMs: 10_000 },
		responses: [
			{ content: "partial before retry", stopReason: "error", errorMessage: "503 retry paused" },
			{ content: "should not run" },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("request to abort during retry");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "partial before retry",
	);
	await harness.waitForAutoRetryStart();
	harness.telegram.receiveText("/stop");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Aborted current turn.",
	);
	await harness.waitForAgentSettled(1);
	assert.equal((await harness.getFauxCalls()).length, 1);
	assert.deepEqual(
		harness.telegram.getMessages().map(({ markdown, silent }) => ({ markdown, silent })),
		[
			{ markdown: "partial before retry", silent: true },
			{ markdown: "Aborted current turn.", silent: false },
		],
	);
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
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "scripted permanent failure",
	);
	await harness.waitForAgentSettled(1);
	assert.deepEqual(
		harness.telegram.getMessages().map(({ markdown, silent }) => ({ markdown, silent })),
		[
			{ markdown: "partial output before failure", silent: true },
			{ markdown: "scripted permanent failure", silent: false },
		],
	);
	assert.equal((await harness.getFauxCalls()).length, 1);
});
