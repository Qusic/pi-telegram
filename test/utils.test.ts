import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeFileName } from "../src/utils.ts";

test("sanitizeFileName keeps readable names but no path syntax", () => {
	assert.equal(sanitizeFileName("报告 v2 (final).pdf"), "报告 v2 (final).pdf");
	assert.equal(sanitizeFileName("../a/b\\c:d?.txt"), ".._a_b_c_d_.txt");
	assert.equal(sanitizeFileName("line\nbreak\u0000.txt"), "line_break_.txt");
});
