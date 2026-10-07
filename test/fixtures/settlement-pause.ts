import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const readyPath = process.env.PI_TELEGRAM_SETTLEMENT_READY;
	const releasePath = process.env.PI_TELEGRAM_SETTLEMENT_RELEASE;
	if (!readyPath || !releasePath) throw new Error("Settlement pause paths are required");
	let first = true;
	pi.on("agent_settled", async () => {
		if (!first) return;
		first = false;
		await writeFile(readyPath, "ready");
		while (true) {
			try {
				await access(releasePath);
				return;
			} catch {
				await delay(5);
			}
		}
	});
}
