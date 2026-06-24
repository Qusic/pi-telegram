// Pure helpers to split a growing markdown answer into messages under the
// per-message limit. The only block that breaks when split is a fenced code
// block, so we prefer to cut at a fence-depth-0 boundary (nextBoundary) and
// render each piece with the fence context it starts/ends in (renderChunk) —
// reopening a carried-over fence and closing a dangling one. At a clean boundary
// there's none, so a normal split and a forced mid-fence split share one path.

/** A fenced code block's opener — enough to re-open it in a continuation. */
interface OpenFence {
	marker: string;
	info: string;
}

// ≤3-space-indented run of ≥3 backticks/tildes, then the info string.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Walk `text` line by line tracking fenced-code state, invoking `onLine` with
 *  the fence state *before* each line. Returns the fence still open at the end,
 *  or null. A closer needs the same char, length ≥ the opener, nothing after. */
function scanLines(
	text: string,
	onLine?: (lineStart: number, insideFence: boolean, line: string) => void,
): OpenFence | null {
	let open: OpenFence | null = null;
	let pos = 0;
	for (;;) {
		const nl = text.indexOf("\n", pos);
		const end = nl === -1 ? text.length : nl;
		const line = text.slice(pos, end);
		onLine?.(pos, open !== null, line);
		const m = FENCE_RE.exec(line);
		if (m) {
			const marker = m[1];
			const info = m[2];
			if (!open) {
				// A backtick fence's info string may not contain a backtick.
				if (marker[0] === "~" || !info.includes("`")) open = { marker, info: info.trim() };
			} else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info.trim() === "") {
				open = null;
			}
		}
		if (nl === -1) return open;
		pos = nl + 1;
	}
}

/** The fenced code block still open at the end of `text`, or null. */
function openFenceAt(text: string): OpenFence | null {
	return scanLines(text);
}

/** Where to cut a chunk starting at `from`: the latest fence-depth-0 boundary
 *  at or before `from + maxLen` (paragraph > line), else a word break, else a
 *  hard cut. Always returns an offset greater than `from`. */
export function nextBoundary(text: string, from: number, maxLen: number): number {
	const limit = Math.min(text.length, from + maxLen);
	let lastLine = -1;
	let lastPara = -1;
	let prevBlank = false;
	scanLines(text, (lineStart, insideFence, line) => {
		if (lineStart > from && lineStart <= limit && !insideFence) {
			lastLine = lineStart;
			if (prevBlank) lastPara = lineStart;
		}
		prevBlank = line.trim() === "";
	});
	if (lastPara > from) return lastPara;
	if (lastLine > from) return lastLine;
	const space = text.lastIndexOf(" ", limit);
	return space > from ? space + 1 : limit;
}

/** Wrap a raw slice into self-contained markdown: reopen `openStart` and close
 *  `openEnd`. Both null at a clean boundary, so the slice passes through. */
function renderSegment(raw: string, openStart: OpenFence | null, openEnd: OpenFence | null): string {
	const pre = openStart ? `${openStart.marker}${openStart.info}\n` : "";
	const suf = openEnd ? `${raw.endsWith("\n") ? "" : "\n"}${openEnd.marker}` : "";
	return pre + raw + suf;
}

/** Render `text[from, to)` as a standalone message, reopening a code fence
 *  carried over from before `from` and closing one left open at `to`. At a
 *  clean boundary it's just the slice. */
export function renderChunk(text: string, from: number, to: number): string {
	return renderSegment(
		text.slice(from, to),
		openFenceAt(text.slice(0, from)),
		openFenceAt(text.slice(0, to)),
	);
}
