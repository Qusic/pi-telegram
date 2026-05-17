// Loads telegram.json at construction, persists on update.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
	lastUpdateId?: number;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		return JSON.parse(content) as TelegramConfig;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

function validateConfig(config: TelegramConfig): void {
	if (!config.botToken) {
		throw new Error(
			`Telegram bridge: ${CONFIG_PATH} missing "botToken". ` +
			`Create the file with {"botToken": "<bot-token-from-BotFather>"} and restart. ` +
			`Optionally set "allowedUserId" too — if omitted, the bot will report your user id when you first message it.`,
		);
	}
}

export type ConfigManager = {
	get(): TelegramConfig;
	update(patch: Partial<TelegramConfig>): Promise<void>;
};

export async function createConfig(): Promise<ConfigManager> {
	let config = await readConfig();
	validateConfig(config);
	return {
		get: () => config,
		update: async (patch) => {
			config = { ...config, ...patch };
			await writeConfig(config);
		},
	};
}
