import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import {
  parseDocument,
  runIsolatedParser,
  runWorkerTimeoutProbe,
  validateSourceLocator,
  type ParserLimits,
  type ParserFormat,
  type ParseResult,
} from "../../scripts/parser-spike.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const formats: ParserFormat[] = ["txt", "md", "pdf", "docx", "html"];

function fixture(format: ParserFormat, name: string): string {
  return join(root, "fixtures", "parsers", format, `${name}.${format}`);
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

async function parseFixture(format: ParserFormat, name: string, limits: Partial<ParserLimits> = {}): Promise<{ result: ParseResult; isolated?: Awaited<ReturnType<typeof runIsolatedParser>> }> {
  const path = fixture(format, name);
  const bytes = await readFile(path);
  if (format === "pdf" || format === "docx") {
    const isolated = await runIsolatedParser(format, bytes, limits);
    assert.equal(isolated.worker.timedOut, false, `${format}/${name} worker timed out`);
    assert.equal(isolated.worker.memoryExceeded, false, `${format}/${name} worker exceeded its RSS limit`);
    if (process.platform === "linux" || process.platform === "darwin") {
      assert.equal(isolated.worker.memoryMonitorAvailable, true, `${format}/${name} worker RSS was not measured`);
      assert.ok((isolated.worker.peakRssBytes ?? 0) > 0);
    }
    assert.equal(isolated.worker.exitCode, 0, `${format}/${name} worker failed: ${isolated.worker.stderr || isolated.worker.workerError || isolated.worker.signal}`);
    assert.ok(isolated.result, `${format}/${name} worker returned no parse result`);
    return { result: isolated.result, isolated };
  }
  return { result: await parseDocument(format, bytes, limits) };
}

function assertGlobalSpans(result: Extract<ParseResult, { status: "parsed" }>): void {
  const normalized = codePoints(result.normalizedText);
  assert.ok(result.spans.length > 0);
  for (const span of result.spans) {
    const locatorCheck = validateSourceLocator(span.locator);
    assert.equal(locatorCheck.valid, true, `${span.locator.kind} locator violates contracts/document-result.schema.json: ${locatorCheck.errors.join("; ")}`);
    assert.ok(span.startOffset >= 0, `${span.locator.kind} starts before normalized text`);
    assert.ok(span.endOffset >= span.startOffset, `${span.locator.kind} has a reversed range`);
    assert.ok(span.endOffset <= normalized.length, `${span.locator.kind} exceeds normalized text`);
    assert.ok(normalized.slice(span.startOffset, span.endOffset).join("").trim().length > 0, `${span.locator.kind} points at empty text`);
  }
}

test("all five real formats preserve non-empty text and source spans", async () => {
  const results = new Map<ParserFormat, Extract<ParseResult, { status: "parsed" }>>();
  for (const format of formats) {
    const { result } = await parseFixture(format, "normal");
    assert.equal(result.status, "parsed", `${format} did not parse: ${result.status === "failed" ? result.errorCode : ""}`);
    assert.ok(result.normalizedText.trim().length > 0, `${format} returned empty text`);
    assertGlobalSpans(result);
    results.set(format, result);
  }

  const txt = results.get("txt")!;
  assert.ok(txt.normalizedText.includes("😀") && txt.normalizedText.includes("e\u0301"));
  assert.notEqual(txt.normalizedText.length, codePoints(txt.normalizedText).length, "fixture must prove offsets count Unicode code points rather than UTF-16 units");
  const txtFirstLine = txt.spans.find((span) => span.locator.kind === "text_span" && span.locator.startLine === 1)!;
  const txtFirstBlock = "标题与定位 😀\n中文行：café；分解形式 e\u0301。\n最后一行。";
  assert.deepEqual([txtFirstLine.startOffset, txtFirstLine.endOffset], [0, codePoints(txtFirstBlock).length]);
  assert.equal(codePoints(txt.normalizedText).slice(txtFirstLine.startOffset, txtFirstLine.endOffset).join(""), txtFirstBlock);

  const md = results.get("md")!;
  const mdBody = md.spans.find((span) => span.locator.kind === "text_span" && span.locator.startLine === 4)!;
  assert.equal(mdBody.locator.kind, "text_span");
  if (mdBody.locator.kind === "text_span") {
    assert.deepEqual(mdBody.headingPath, ["实施方案 😀", "输入约束"]);
    assert.equal(mdBody.locator.startLine, 4);
  }

  const pdf = results.get("pdf")!;
  const pdfSpans = pdf.spans.filter((span) => span.locator.kind === "pdf_page");
  assert.deepEqual(pdfSpans.map((span) => span.locator.kind === "pdf_page" ? span.locator.page : 0), [1, 2]);
  const pdfPages = pdf.normalizedText.split("\n\n").map(codePoints);
  for (const span of pdfSpans) {
    assert.equal(span.locator.kind, "pdf_page");
    if (span.locator.kind === "pdf_page") {
      const page = pdfPages[span.locator.page - 1]!;
      assert.equal(span.locator.endOffset, page.length);
      assert.ok(page.slice(span.locator.startOffset, span.locator.endOffset).join("").length > 0);
    }
  }

  const docx = results.get("docx")!;
  const docxLocators = docx.spans.map((span) => span.locator).filter((locator) => locator.kind === "docx_paragraph");
  assert.deepEqual(docxLocators.map((locator) => locator.kind === "docx_paragraph" ? locator.paragraphIndex : -1), [0, 2, 3, 4, 5]);
  assert.deepEqual(docxLocators[0]?.kind === "docx_paragraph" ? docxLocators[0].headingPath : [], ["实施要点 😀"]);
  assert.deepEqual(docx.spans.map((span) => codePoints(docx.normalizedText).slice(span.startOffset, span.endOffset).join("")), [
    "实施要点 😀",
    "重复段落。",
    "重复段落。",
    "来源",
    "中文定位：café，分解形式 e\u0301，emoji 🙂，编号 DOC-42。",
  ]);

  const html = results.get("html")!;
  const htmlSection = html.spans.find((span) => span.locator.kind === "html_section" && span.locator.headingPath.includes("来源") && span.locator.fragment === "");
  assert.ok(htmlSection);
  if (htmlSection?.locator.kind === "html_section") assert.equal(htmlSection.locator.fragment, "");
  const actualHtmlId = html.spans.find((span) => span.locator.kind === "html_section" && span.locator.headingPath.length === 1);
  assert.ok(actualHtmlId?.locator.kind === "html_section" && actualHtmlId.locator.fragment === "overview");
});

test("valid empty documents fail instead of reporting parsed", async () => {
  for (const format of formats) {
    const { result } = await parseFixture(format, "empty");
    assert.equal(result.status, "failed", `${format} empty sample was incorrectly accepted`);
    if (result.status === "failed") assert.equal(result.errorCode, format === "txt" ? "EMPTY_INPUT" : "EMPTY_PARSE");
  }
});

test("corrupt input is reported as a parser failure", async () => {
  for (const format of formats) {
    const { result } = await parseFixture(format, "corrupt");
    assert.equal(result.status, "failed", `${format} corrupt sample was incorrectly accepted`);
    if (result.status === "failed") assert.equal(result.errorCode, "CORRUPT_DOCUMENT");
  }
});

test("each over-limit fixture is a real format and hits the intended guard", async () => {
  for (const format of formats) {
    const limits = format === "pdf" ? { maxPdfPages: 500 }
      : format === "docx" ? { maxExpandedBytes: 512 }
        : { maxBytes: 512 };
    const input = await readFile(fixture(format, "over-limit"));
    if (format === "pdf") assert.equal(input.toString("ascii", 0, 5), "%PDF-");
    if (format === "docx") assert.equal(input.toString("ascii", 0, 2), "PK");
    if (format === "html") assert.match(input.toString("utf8"), /<html/i);
    const { result } = await parseFixture(format, "over-limit", limits);
    assert.equal(result.status, "failed", `${format} over-limit sample was incorrectly accepted`);
    if (result.status === "failed") {
      const expected = format === "pdf" ? "PAGE_LIMIT" : format === "docx" ? "EXPANDED_SIZE_LIMIT" : "SIZE_LIMIT";
      assert.equal(result.errorCode, expected);
    }
  }
});

test("DOCX bounded inflate rejects bytes that ZIP metadata understates", async () => {
  const path = fixture("docx", "forged-expanded");
  const bytes = await readFile(path);
  assert.equal(bytes.toString("ascii", 0, 2), "PK");
  const isolated = await runIsolatedParser("docx", bytes, { maxExpandedBytes: 512 });
  assert.equal(isolated.worker.timedOut, false);
  assert.equal(isolated.worker.memoryExceeded, false);
  assert.equal(isolated.worker.exitCode, 0);
  assert.equal(isolated.result?.status, "failed");
  if (isolated.result?.status === "failed") assert.equal(isolated.result.errorCode, "EXPANDED_SIZE_LIMIT");
});

test("production 50 MiB byte boundary rejects before parsing", async () => {
  const input = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
  const result = await parseDocument("txt", input);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.errorCode, "SIZE_LIMIT");
});

test("PDF and DOCX workers enforce timeout and terminate cleanly", async () => {
  const timeout = await runWorkerTimeoutProbe();
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.exitCode, null);
  assert.ok(timeout.signal, "timeout probe process must terminate by signal");
});
