import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { startFakeTelegramServer } from "./fake-telegram-server.ts";
import type { FauxScript, FauxTraceEntry } from "./faux-script.ts";

interface RpcResponse<T = unknown> {
	type: "response";
	id: string;
	command: string;
	success: boolean;
	data?: T;
	error?: string;
}

interface PendingRpcRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ExtensionErrorRecord {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

function isRpcResponse(value: unknown): value is RpcResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "response" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

function isExtensionError(value: unknown): value is ExtensionErrorRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "extension_error" &&
		"extensionPath" in value &&
		typeof value.extensionPath === "string" &&
		"event" in value &&
		typeof value.event === "string" &&
		"error" in value &&
		typeof value.error === "string"
	);
}

async function waitFor<T>(
	find: () => T | undefined | Promise<T | undefined>,
	description: string,
	timeout: number,
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await find();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

class PiRpcProcess {
	readonly records: unknown[] = [];
	readonly stderr: string[] = [];

	#child: ChildProcessWithoutNullStreams;
	#pending = new Map<string, PendingRpcRequest>();
	#nextRequestId = 1;
	#stdoutBuffer = "";
	#stderrBuffer = "";
	#closed = false;
	#closedPromise: Promise<void>;
	#failure: Error | undefined;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		this.#closedPromise = new Promise((resolve) => {
			child.once("close", (code, signal) => {
				this.#closed = true;
				this.#flushStderr();
				this.#fail(
					new Error(
						`pi exited (code ${code}, signal ${signal})${this.stderr.length ? `\n${this.stderr.join("\n")}` : ""}`,
					),
				);
				resolve();
			});
		});
		child.once("error", (cause) => this.#fail(new Error(`Failed to start pi: ${cause.message}`, { cause })));
		child.stdin.on("error", (cause) => this.#fail(new Error(`Failed to write to pi: ${cause.message}`, { cause })));
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.#consumeStdout(chunk));
		child.stderr.on("data", (chunk: string) => this.#consumeStderr(chunk));
	}

	get extensionErrors(): ExtensionErrorRecord[] {
		return this.records.filter(isExtensionError);
	}

	async commandData<T>(command: Record<string, unknown>, timeout = 5_000): Promise<T> {
		const response = await this.command<T>(command, timeout);
		if (!response.success) throw new Error(response.error ?? `RPC command ${response.command} failed`);
		if (response.data === undefined) throw new Error(`RPC command ${response.command} returned no data`);
		return response.data;
	}

	async command<T = unknown>(command: Record<string, unknown>, timeout = 5_000): Promise<RpcResponse<T>> {
		if (this.#failure) throw this.#failure;
		const id = `test-${this.#nextRequestId++}`;
		const response = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Timed out after ${timeout}ms waiting for RPC response to ${String(command.type)}`));
			}, timeout);
			this.#pending.set(id, { resolve, reject, timer });
		});
		this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return (await response) as RpcResponse<T>;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#child.kill("SIGTERM");
		const graceful = await Promise.race([
			this.#closedPromise.then(() => true),
			new Promise<false>((resolve) => {
				setTimeout(() => resolve(false), 2_000).unref();
			}),
		]);
		if (graceful) return;
		this.#child.kill("SIGKILL");
		await this.#closedPromise;
	}

	#fail(error: Error): void {
		if (this.#failure) return;
		this.#failure = error;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#consumeStdout(chunk: string): void {
		this.#stdoutBuffer += chunk;
		for (;;) {
			const newline = this.#stdoutBuffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				this.stderr.push(`Non-JSON RPC stdout: ${line}`);
				continue;
			}
			this.records.push(record);
			if (!isRpcResponse(record)) continue;
			const pending = this.#pending.get(record.id);
			if (!pending) continue;
			this.#pending.delete(record.id);
			clearTimeout(pending.timer);
			pending.resolve(record);
		}
	}

	#consumeStderr(chunk: string): void {
		this.#stderrBuffer += chunk;
		for (;;) {
			const newline = this.#stderrBuffer.indexOf("\n");
			if (newline === -1) return;
			this.stderr.push(this.#stderrBuffer.slice(0, newline).replace(/\r$/, ""));
			this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1);
		}
	}

	#flushStderr(): void {
		const remaining = this.#stderrBuffer.replace(/\r$/, "");
		if (remaining) this.stderr.push(remaining);
		this.#stderrBuffer = "";
	}
}

type FakeTelegramServer = Awaited<ReturnType<typeof startFakeTelegramServer>>;

type PiProcessHarnessOptions = FauxScript & {
	thinkingLevel?: ModelThinkingLevel;
};

interface PiProcessHarness {
	readonly telegram: Pick<FakeTelegramServer, "receiveText" | "waitForText">;
	readonly extensionErrors: readonly ExtensionErrorRecord[];
	getState(): Promise<RpcSessionState>;
	getFauxCalls(): Promise<FauxTraceEntry[]>;
	waitForFauxCalls(count: number, timeout?: number): Promise<FauxTraceEntry[]>;
	waitForIdle(timeout?: number): Promise<void>;
	dispose(): Promise<void>;
}

export async function createPiProcessHarness(options: PiProcessHarnessOptions): Promise<PiProcessHarness> {
	const { thinkingLevel = "high", ...script } = options;
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-process-test-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	const scriptPath = join(root, "faux-script.json");
	const tracePath = join(root, "faux-trace.jsonl");
	const telegram = await startFakeTelegramServer();
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
	await Promise.all([
		writeFile(
			join(agentDir, "telegram.json"),
			`${JSON.stringify({ botToken: "test-token", apiRoot: telegram.apiRoot, allowedUserId: 42, lastUpdateId: 0 }, null, 2)}\n`,
		),
		writeFile(scriptPath, `${JSON.stringify(script, null, 2)}\n`),
		writeFile(tracePath, ""),
	]);

	const projectRoot = resolve(import.meta.dirname, "../..");
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const piCli = join(dirname(piEntry), "bundle", "cli.js");
	const child = spawn(
		process.execPath,
		[
			piCli,
			"--mode",
			"rpc",
			"--offline",
			"--no-extensions",
			"--extension",
			join(projectRoot, "src", "index.ts"),
			"--extension",
			join(projectRoot, "test", "fixtures", "faux-provider.ts"),
			"--no-skills",
			"--skill",
			join(projectRoot, "test", "fixtures", "skills", "fixture-skill", "SKILL.md"),
			"--no-prompt-templates",
			"--no-context-files",
			"--model",
			"pi-telegram-test/faux-1",
			"--thinking",
			thinkingLevel,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				SHELL: process.env.SHELL,
				TMPDIR: process.env.TMPDIR,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
				SystemRoot: process.env.SystemRoot,
				ComSpec: process.env.ComSpec,
				PATHEXT: process.env.PATHEXT,
				CI: process.env.CI,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				PI_TELEGRAM_FAUX_SCRIPT: scriptPath,
				PI_TELEGRAM_FAUX_TRACE: tracePath,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const rpc = new PiRpcProcess(child);

	const readFauxCalls = async (): Promise<FauxTraceEntry[]> => {
		const content = await readFile(tracePath, "utf8");
		return content
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as FauxTraceEntry);
	};

	try {
		await rpc.commandData({ type: "get_state" });
		await telegram.waitForCall((call) => call.method === "getUpdates");
	} catch (error) {
		const fauxTrace = await readFile(tracePath, "utf8");
		const diagnostics = [
			`Faux trace: ${JSON.stringify(fauxTrace)}`,
			`Telegram: ${JSON.stringify(telegram.getDiagnostics())}`,
			`RPC records: ${JSON.stringify(rpc.records)}`,
			`stderr: ${rpc.stderr.join("\n")}`,
		].join("\n");
		await rpc.close();
		await telegram.close();
		await rm(root, { recursive: true, force: true });
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`, { cause: error });
	}

	const telegramClient: PiProcessHarness["telegram"] = {
		receiveText: (text, receiveOptions) => telegram.receiveText(text, receiveOptions),
		waitForText: (predicate, timeout) => telegram.waitForText(predicate, timeout),
	};
	let disposed = false;
	return {
		telegram: telegramClient,
		get extensionErrors() {
			return rpc.extensionErrors;
		},
		getState: () => rpc.commandData<RpcSessionState>({ type: "get_state" }),
		getFauxCalls: readFauxCalls,
		waitForFauxCalls: (count, timeout = 5_000) =>
			waitFor(
				async () => {
					const calls = await readFauxCalls();
					return calls.length >= count ? calls : undefined;
				},
				`${count} faux provider call(s)`,
				timeout,
			),
		waitForIdle: async (timeout = 5_000) => {
			await waitFor(
				async () => {
					const state = await rpc.commandData<RpcSessionState>({ type: "get_state" });
					return !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0 ? true : undefined;
				},
				"pi to become idle",
				timeout,
			);
		},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			try {
				await rpc.close();
			} finally {
				try {
					await telegram.close();
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			}
		},
	};
}
