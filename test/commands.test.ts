import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiProcessHarness } from "./support/pi-process.ts";

test("missing authorization warns in pi for an update queued before startup", async (t) => {
	const userId = 314_159;
	const harness = await createPiProcessHarness({
		responses: [],
		telegramConfig: {},
		preloadedTelegramMessages: [{ text: "bootstrap authorization", userId }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	const warning = await harness.waitForNotification((notification) => notification.message.includes(String(userId)));
	assert.equal(warning.notifyType, "warning");
	assert.equal(
		warning.message,
		`Telegram user id ${userId} needs authorization. ` +
			`Add "allowedUserId": ${userId} to ~/.pi/agent/telegram.json, then restart pi.`,
	);
	assert.equal(harness.telegram.getSentTextCount(), 0);
	assert.deepEqual(await harness.getFauxCalls(), []);
});

test("startup cursor still skips queued turns after authorization", async (t) => {
	const harness = await createPiProcessHarness({
		responses: [{ content: "fresh reply" }],
		telegramConfig: { allowedUserId: 42 },
		preloadedTelegramMessages: [{ text: "stale queued request" }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	assert.deepEqual(await harness.getFauxCalls(), []);
	harness.telegram.receiveText("fresh request");
	await harness.telegram.waitForText((message) => message.kind === "message" && message.markdown === "fresh reply");
	await harness.waitForIdle();
	assert.equal((await harness.getFauxCalls()).length, 1);
});

test("unauthorized Telegram users are silently ignored", async (t) => {
	const harness = await createPiProcessHarness({ responses: [] });
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	const updateId = harness.telegram.receiveText("intruder request", { userId: 999 });
	await harness.telegram.waitForUpdateConsumed(updateId);
	assert.equal(harness.telegram.getSentTextCount(), 0);
	assert.deepEqual(await harness.getFauxCalls(), []);
});

test("/status reports real session usage without invoking the model", async (t) => {
	const harness = await createPiProcessHarness({ responses: [{ content: "status seed reply" }] });
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("seed status data");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "status seed reply",
	);
	await harness.waitForIdle();
	harness.telegram.receiveText("/status");
	const status = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.startsWith("**Status**"),
	);
	await harness.waitForIdle();

	assert.equal(status.silent, false);
	assert.match(status.markdown, /\*\*Model\*\* — `pi-telegram-test\/faux-1`/);
	assert.match(status.markdown, /\*\*Tokens\*\* — ↑\S+ ↓\S+/);
	assert.match(status.markdown, /\*\*Context\*\* — \d+\.\d+% \/ 128k/);
	assert.equal((await harness.getFauxCalls()).length, 1);
});
