// Compact tool breadcrumbs: one line per call, one silent message per batch.
// Shared-message writes are serialized and coalesced; turn_end seals the batch.

import { type createApi, MAX_MESSAGE_LENGTH } from "./api.ts";

const EDIT_THROTTLE_MS = 500;
// Heuristic for a compact mobile row; actual wrap depends on chat width and font.
const NAME_MAX = 24;
const SUMMARY_MAX = 24;
// A bare newline is a soft break in GFM and can render as a space.
const TOOL_LINE_BREAK = "  \n";

const STATUS_ICON = {
	running: "🔧",
	success: "✅",
	error: "❌",
	cancelled: "🚫", // batch closed without a tool_execution_end
} as const;

type ToolStatus = keyof typeof STATUS_ICON;

type ToolApi = Pick<ReturnType<typeof createApi>, "sendText" | "editText">;

interface ToolCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
	parentToolCallId?: string;
}

interface ToolLine {
	text: string;
	nested: boolean;
	status: ToolStatus;
}

interface ToolPage {
	lines: ToolLine[];
	budget: number;
	messageId: number | undefined;
	lastText: string;
}

interface ToolBatch {
	chatId: number;
	calls: Map<string, ToolLine>;
	pages: ToolPage[];
	flushTimer: ReturnType<typeof setTimeout> | undefined;
}

function oneLine(text: string): string {
	// Parameters must not create extra tool rows.
	return text.replace(/\s+/g, " ").trim();
}

function neutralizeBackticks(text: string): string {
	// Dynamic text must not open or close a Markdown code span.
	return text.replaceAll("`", "ʼ");
}

function inlineCode(text: string): string {
	return `\`${neutralizeBackticks(text)}\``;
}

function boldToolName(name: string): string {
	// Keep punctuation in custom tool names from becoming Markdown/HTML markup.
	return `**${neutralizeBackticks(name).replace(/[\\*_~[\]<>]/g, "\\$&")}**`;
}

function shortenStart(text: string, max: number): string {
	if (text.length <= max) return text;
	// Don't split an emoji's UTF-16 surrogate pair at the cut.
	return `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function shortenPath(value: string, max: number): string {
	const path = oneLine(value);
	if (path.length <= max) return path;
	const suffix = path.replaceAll("\\", "/").slice(-(max - 1));
	const separator = suffix.indexOf("/");
	// Keep as many complete trailing directories as fit. Only cut through the
	// filename if that final segment alone exceeds the budget.
	const tail = separator < 0 ? suffix.replace(/^[\uDC00-\uDFFF]/, "") : suffix.slice(separator);
	return `…${tail}`;
}

function summarizeArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const fields = args as Record<string, unknown>;
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return typeof fields.path === "string" ? shortenPath(fields.path, SUMMARY_MAX) : "";
		case "bash":
		case "powershell":
			return typeof fields.command === "string" ? shortenStart(oneLine(fields.command), SUMMARY_MAX) : "";
		case "grep":
		case "find":
			return typeof fields.pattern === "string" ? shortenStart(oneLine(fields.pattern), SUMMARY_MAX) : "";
		case "telegram_attach": {
			const paths = fields.paths;
			return Array.isArray(paths) ? `${paths.length} file${paths.length === 1 ? "" : "s"}` : "";
		}
		default:
			// Unknown schemas may contain bulk or sensitive fields; show only the name.
			return "";
	}
}

function renderLine(line: ToolLine): string {
	return `${line.nested ? "↳ " : ""}${STATUS_ICON[line.status]} ${line.text}`;
}

export function createToolMessages(api: ToolApi) {
	let current: ToolBatch | undefined;
	let chain = Promise.resolve();

	function enqueue(task: () => Promise<void>): Promise<void> {
		chain = chain.then(task).catch(() => {});
		return chain;
	}

	async function flush(batch: ToolBatch): Promise<void> {
		for (const page of batch.pages) {
			const text = page.lines.map(renderLine).join(TOOL_LINE_BREAK);
			if (text === page.lastText) continue;
			try {
				if (page.messageId === undefined) {
					const sent = await api.sendText(batch.chatId, text, { silent: true });
					page.messageId = sent.message_id;
				} else {
					await api.editText(batch.chatId, page.messageId, text);
				}
				page.lastText = text;
			} catch {
				// Breadcrumbs are best-effort. Retry this page on a later flush,
				// but don't prevent the remaining pages from being written.
			}
		}
	}

	// Merge rapid tool starts/completions into one Telegram edit; the first
	// message is sent immediately, and finalize() flushes without waiting.
	function scheduleFlush(batch: ToolBatch): void {
		if (batch.flushTimer) return;
		batch.flushTimer = setTimeout(() => {
			batch.flushTimer = undefined;
			void enqueue(() => (current === batch ? flush(batch) : Promise.resolve()));
		}, EDIT_THROTTLE_MS);
	}

	async function start(chatId: number, call: ToolCall): Promise<void> {
		if (call.parentToolCallId && (current?.chatId !== chatId || !current.calls.has(call.parentToolCallId))) return;
		// Record synchronously before any await; the writer queue preserves send order.
		if (current && current.chatId !== chatId) void finalize();
		current ??= { chatId, calls: new Map(), pages: [], flushTimer: undefined };
		const batch = current;
		if (batch.calls.has(call.toolCallId)) return;
		const name = boldToolName(shortenStart(oneLine(call.toolName), NAME_MAX));
		const args = summarizeArgs(call.toolName, call.args);
		const line: ToolLine = {
			text: `${name}${args ? ` · ${inlineCode(args)}` : ""}`,
			nested: call.parentToolCallId !== undefined,
			status: "running",
		};
		batch.calls.set(call.toolCallId, line);
		// Running and cancelled icons have the same length; reserve a break
		// so status edits never move a line between pages.
		const budget = renderLine(line).length + TOOL_LINE_BREAK.length;
		let page = batch.pages.at(-1);
		if (!page || page.budget + budget > MAX_MESSAGE_LENGTH) {
			page = { lines: [], budget: 0, messageId: undefined, lastText: "" };
			batch.pages.push(page);
		}
		page.lines.push(line);
		page.budget += budget;
		if (page.messageId === undefined) await enqueue(() => flush(batch));
		else scheduleFlush(batch);
	}

	function end(toolCallId: string, isError: boolean): void {
		const batch = current;
		const line = batch?.calls.get(toolCallId);
		if (!batch || !line) return;
		line.status = isError ? "error" : "success";
		scheduleFlush(batch);
	}

	function finalize(): Promise<void> {
		const batch = current;
		if (!batch) return chain;
		current = undefined;
		if (batch.flushTimer) clearTimeout(batch.flushTimer);
		for (const line of batch.calls.values()) {
			if (line.status === "running") line.status = "cancelled";
		}
		return enqueue(() => flush(batch));
	}

	return { start, end, finalize };
}
