import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  DEFAULT_PARSER_LIMITS,
  parseDocument,
  type ParserFormat,
  type ParserLimits,
  type ParseFailure,
  type ParseResult,
  type SourceLocator,
  type SourceSpan,
} from '../src/ingestion/parser.js';

export { parseDocument };
export type { ParserFormat, ParserLimits, ParseResult };

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures', 'parsers');
const REPORT_PATH = join(REPO_ROOT, 'evidence', 'm0', 'parser-matrix.json');
const DECISIONS_PATH = join(REPO_ROOT, 'evidence', 'm0', 'parser-decisions.json');
const PARSER_WORKER = fileURLToPath(new URL('../src/ingestion/parser-worker.ts', import.meta.url));
const DEFAULT_LIMITS: ParserLimits = { ...DEFAULT_PARSER_LIMITS };
const WORKER_OLD_SPACE_MIB = 512;
const WORKER_RSS_LIMIT_BYTES = 1024 * 1024 * 1024;
const PDFJS_VERSION = '6.4.299';
const CHEERIO_VERSION = '1.2.0';
const RESULT_SCHEMA_PATH = join(REPO_ROOT, 'contracts', 'document-result.schema.json');
const resultSchema = JSON.parse(readFileSync(RESULT_SCHEMA_PATH, 'utf8')) as {
  $schema: string;
  $defs: { locator: Record<string, unknown> };
};
const validateLocatorSchema = new Ajv2020({ allErrors: true, strict: false }).compile(resultSchema.$defs.locator);

export function validateSourceLocator(locator: unknown): { valid: boolean; errors: string[] } {
  const valid = validateLocatorSchema(locator);
  return {
    valid,
    errors: valid ? [] : (validateLocatorSchema.errors ?? []).map((error: { instancePath: string; message?: string }) => String(error.instancePath || '/') + ' ' + String(error.message ?? 'schema validation failed')),
  };
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(pages: string[][]): Buffer {
  const pageCount = pages.length;
  const fontId = 3 + pageCount * 2;
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  pages.forEach((lines, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const operations = lines.map((line, lineIndex) => `BT /F1 14 Tf 72 ${720 - lineIndex * 24} Td (${escapePdfLiteral(line)}) Tj ET`).join("\n");
    const stream = `${operations}\n`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  });
  objects[fontId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(output, "ascii");
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Array<{ name: string; data: Buffer; store?: boolean; declaredUncompressedSize?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = entry.store ? entry.data : deflateRawSync(entry.data);
    const method = entry.store ? 0 : 8;
    const checksum = crc32(entry.data);
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function docxParagraph(text: string, style?: string): string {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

export function makeDocx(paragraphs: Array<{ text: string; style?: string }>, lieAboutUncompressedSize = false): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((paragraph) => docxParagraph(paragraph.text, paragraph.style)).join("")}<w:sectPr/></w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;
  const parts = [
    { name: "[Content_Types].xml", data: Buffer.from(types) },
    { name: "_rels/.rels", data: Buffer.from(rels) },
    { name: "word/document.xml", data: Buffer.from(document) },
    { name: "word/styles.xml", data: Buffer.from(styles) },
  ];
  return makeZip(parts.map((part) => ({ ...part, ...(lieAboutUncompressedSize ? { declaredUncompressedSize: 0 } : {}) })));
}

async function generateFixtures(): Promise<void> {
  const samples: Record<ParserFormat, Record<string, Buffer>> = {
    txt: {
      "normal.txt": Buffer.from("标题与定位 😀\n中文行：café；分解形式 e\u0301。\n最后一行。\n", "utf8"),
      "empty.txt": Buffer.alloc(0),
      "corrupt.txt": Buffer.from([0xc3, 0x28, 0xff]),
      "over-limit.txt": Buffer.from(`${"合法超限样本文本。\n".repeat(64)}`, "utf8"),
    },
    md: {
      "normal.md": Buffer.from("# 实施方案 😀\n\n## 输入约束\n支持中文、café 与 e\u0301。\n\n正文含一个精确编号：DOC-42。\n", "utf8"),
      "empty.md": Buffer.from("  \n\n", "utf8"),
      "corrupt.md": Buffer.from([0xe2, 0x28, 0xa1]),
      "over-limit.md": Buffer.from(`# 超限标题\n\n${"这是有效 Markdown 内容。\n".repeat(64)}`, "utf8"),
    },
    pdf: {
      "normal.pdf": makePdf([["First PDF page: source location."], ["Second page: DOC-42." ]]),
      "empty.pdf": makePdf([[]]),
      "corrupt.pdf": Buffer.from("%PDF-1.4\nthis is not a valid xref or object table\n", "ascii"),
      "over-limit.pdf": makePdf(Array.from({ length: 501 }, (_, index) => [`Page ${index + 1} over the page limit.`])),
    },
    docx: {
      "normal.docx": makeDocx([
        { text: "实施要点 😀", style: "Heading1" },
        { text: "" },
        { text: "重复段落。" },
        { text: "重复段落。" },
        { text: "来源", style: "Heading2" },
        { text: "中文定位：café，分解形式 e\u0301，emoji 🙂，编号 DOC-42。" },
      ]),
      "empty.docx": makeDocx([]),
      "corrupt.docx": Buffer.from("PK\u0003\u0004broken-docx-package", "binary"),
      "over-limit.docx": makeDocx([
        { text: "合法压缩 DOCX 超限样本：" + "扩展内容🙂".repeat(96) },
      ]),
      "forged-expanded.docx": makeDocx([
        { text: "损坏目录长度声明的 DOCX：" + "扩展内容🙂".repeat(96) },
      ], true),
    },
    html: {
      "normal.html": Buffer.from("<!doctype html><html><body><h1 id=\"overview\">知识说明 😀</h1><p>中文定位：café 和 e\u0301。</p><h2>来源</h2><p>引用编号 DOC-42。</p></body></html>", "utf8"),
      "empty.html": Buffer.from("<!doctype html><html><body><main></main></body></html>", "utf8"),
      "corrupt.html": Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xc3, 0x28, 0x3c, 0x2f, 0x70, 0x3e]),
      "over-limit.html": Buffer.from(`<!doctype html><html><body><main><h1>超限</h1><p>${"有效 HTML 内容。".repeat(128)}</p></main></body></html>`, "utf8"),
    },
  };
  for (const [format, files] of Object.entries(samples) as Array<[ParserFormat, Record<string, Buffer>]>) {
    const directory = join(FIXTURES_DIR, format);
    await mkdir(directory, { recursive: true });
    for (const [name, data] of Object.entries(files)) await writeFile(join(directory, name), data);
  }
}

function fixturePath(format: ParserFormat, name: string): string {
  return join(FIXTURES_DIR, format, name);
}

function limitsForCase(format: ParserFormat, caseName: string): Partial<ParserLimits> {
  if (caseName !== "over-limit") return {};
  switch (format) {
    case "pdf":
      return { maxPdfPages: 500 };
    case "docx":
      return { maxExpandedBytes: 512 };
    default:
      return { maxBytes: 512 };
  }
}

export interface IsolatedResult {
  result?: ParseResult;
  worker: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    wallDurationMs: number;
    stderr: string;
    memoryMonitorAvailable?: boolean;
    memoryExceeded?: boolean;
    peakRssBytes?: number;
    rssLimitBytes?: number;
    workerError?: string;
  };
}

async function readProcessRssBytes(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      return value ? Number(value) * 1024 : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 500 });
      const value = Number(stdout.trim());
      return Number.isFinite(value) ? value * 1024 : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function runIsolatedParser(
  format: ParserFormat,
  input: Buffer,
  limits: Partial<ParserLimits> = {},
  timeoutMs = 120_000,
): Promise<IsolatedResult> {
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${WORKER_OLD_SPACE_MIB}`, "--import", "tsx", PARSER_WORKER, format, JSON.stringify(limits)],
    { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let memoryExceeded = false;
  let memoryMonitorAvailable = false;
  let peakRssBytes = 0;
  let monitorBusy = false;
  let killTimer: NodeJS.Timeout | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const memoryMonitor = setInterval(async () => {
    if (!child.pid || monitorBusy) return;
    monitorBusy = true;
    const rss = await readProcessRssBytes(child.pid);
    monitorBusy = false;
    if (rss === undefined) return;
    memoryMonitorAvailable = true;
    peakRssBytes = Math.max(peakRssBytes, rss);
    if (rss > WORKER_RSS_LIMIT_BYTES && !memoryExceeded) {
      memoryExceeded = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    }
  }, 100);

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
  }, timeoutMs);
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  const close = await closePromise.catch((error: unknown) => ({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) }));
  clearTimeout(timeout);
  clearInterval(memoryMonitor);
  if (killTimer) clearTimeout(killTimer);
  const outputLine = stdout.trim().split("\n").at(-1);
  let result: ParseResult | undefined;
  let workerError: string | undefined = "error" in close ? close.error : undefined;
  if (outputLine) {
    try {
      result = JSON.parse(outputLine) as ParseResult;
    } catch {
      workerError = "Worker stdout did not end with a parse-result JSON line.";
    }
  } else if (!workerError && !timedOut) {
    workerError = "Worker exited without a parse-result JSON line.";
  }
  return {
    ...(result ? { result } : {}),
    worker: {
      exitCode: close.code,
      signal: close.signal,
      timedOut,
      wallDurationMs: Number((performance.now() - startedAt).toFixed(3)),
      stderr: stderr.slice(-4_000),
      memoryMonitorAvailable,
      memoryExceeded,
      peakRssBytes,
      rssLimitBytes: WORKER_RSS_LIMIT_BYTES,
      ...(memoryExceeded ? { workerError: `Worker exceeded the ${WORKER_RSS_LIMIT_BYTES} byte RSS limit.` } : workerError ? { workerError } : {}),
    },
  };
}

export async function runWorkerTimeoutProbe(): Promise<IsolatedResult["worker"]> {
  const probe = await runIsolatedParser("pdf", await readFile(fixturePath("pdf", "normal.pdf")), {}, 1);
  return probe.worker;
}

function resultDetails(result: ParseResult): Record<string, unknown> {
  if (result.status === "failed") return { status: result.status, errorCode: result.errorCode, error: result.error, warnings: result.warnings, durationMs: result.durationMs };
  return {
    status: result.status,
    codePointCount: codePointLength(result.normalizedText),
    utf16Length: result.normalizedText.length,
    spanCount: result.spans.length,
    spans: result.spans,
    warnings: result.warnings,
    durationMs: result.durationMs,
  };
}

function validateSpans(format: ParserFormat, result: Extract<ParseResult, { status: "parsed" }>): string[] {
  const errors: string[] = [];
  const normalized = codePointLength(result.normalizedText);
  const pdfPages = format === "pdf" ? result.normalizedText.split("\n\n").map(codePointLength) : [];
  for (const [index, span] of result.spans.entries()) {
    const locatorCheck = validateSourceLocator(span.locator);
    if (!locatorCheck.valid) errors.push(`span ${index} locator schema: ${locatorCheck.errors.join("; ")}`);
    if (span.startOffset < 0 || span.endOffset < span.startOffset || span.endOffset > normalized) {
      errors.push(`span ${index} global offsets exceed normalized text`);
    }
    if (span.locator.kind === "text_span" && (span.locator.startOffset !== span.startOffset || span.locator.endOffset !== span.endOffset)) {
      errors.push(`span ${index} text_span offsets disagree with normalized-text offsets`);
    }
    if (span.locator.kind === "pdf_page") {
      const pageLength = pdfPages[span.locator.page - 1];
      if (pageLength === undefined || span.locator.startOffset < 0 || span.locator.endOffset < span.locator.startOffset || span.locator.endOffset > pageLength) {
        errors.push(`span ${index} PDF page-local offsets exceed page ${span.locator.page}`);
      }
    }
  }
  return errors;
}

async function parseCase(format: ParserFormat, caseName: string): Promise<{ path: string; bytes: Buffer; result: ParseResult; worker?: IsolatedResult["worker"] }> {
  const name = `${caseName}.${format}`;
  const path = fixturePath(format, name);
  const bytes = await readFile(path);
  if (format === "pdf" || format === "docx") {
    const isolated = await runIsolatedParser(format, bytes, limitsForCase(format, caseName));
    if (!isolated.result) {
      const failure: ParseFailure = {
        status: "failed",
        format,
        errorCode: "CORRUPT_DOCUMENT",
        error: isolated.worker.workerError ?? `Worker exited ${isolated.worker.exitCode}.`,
        warnings: [],
        durationMs: isolated.worker.wallDurationMs,
      };
      return { path, bytes, result: failure, worker: isolated.worker };
    }
    return { path, bytes, result: isolated.result, worker: isolated.worker };
  }
  return { path, bytes, result: await parseDocument(format, bytes, limitsForCase(format, caseName)) };
}

function expectedStatus(format: ParserFormat, caseName: string): { status: ParseResult["status"]; errorCode?: ParseFailure["errorCode"] } {
  switch (caseName) {
    case "normal":
      return { status: "parsed" };
    case "empty":
      return { status: "failed", errorCode: format === "txt" ? "EMPTY_INPUT" : "EMPTY_PARSE" };
    case "corrupt":
      return { status: "failed", errorCode: "CORRUPT_DOCUMENT" };
    case "over-limit":
      return { status: "failed", errorCode: "SIZE_LIMIT" };
    default:
      return { status: "failed" };
  }
}

async function runMatrix(): Promise<{ report: Record<string, unknown>; failures: string[] }> {
  const formats: ParserFormat[] = ["txt", "md", "pdf", "docx", "html"];
  const cases = ["normal", "empty", "corrupt", "over-limit"] as const;
  const failureMessages: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (const format of formats) {
    for (const caseName of cases) {
      const { path, bytes, result, worker } = await parseCase(format, caseName);
      const expected = expectedStatus(format, caseName);
      const effectiveError = result.status === "failed" ? result.errorCode : undefined;
      const expectedError = format === "pdf" && caseName === "over-limit" ? "PAGE_LIMIT"
        : format === "docx" && caseName === "over-limit" ? "EXPANDED_SIZE_LIMIT"
          : expected.errorCode;
      const spanErrors = result.status === "parsed" ? validateSpans(format, result) : [];
      const workerOk = !worker || (!worker.timedOut && !worker.memoryExceeded && worker.exitCode === 0);
      const statusOk = workerOk && result.status === expected.status && effectiveError === expectedError && (caseName !== "normal" || (result.status === "parsed" && result.normalizedText.trim().length > 0 && result.spans.length > 0));
      const ok = statusOk && spanErrors.length === 0;
      if (!statusOk) failureMessages.push(`${format}/${caseName}: expected ${expected.status}${expectedError ? `/${expectedError}` : ""}, got ${result.status}${effectiveError ? `/${effectiveError}` : ""}`);
      if (spanErrors.length > 0) failureMessages.push(`${format}/${caseName}: ${spanErrors.join("; ")}`);
      rows.push({
        format,
        case: caseName,
        fixture: path.slice(REPO_ROOT.length + 1),
        fixtureBytes: bytes.length,
        fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
        configuredLimits: { ...DEFAULT_LIMITS, ...limitsForCase(format, caseName) },
        expected: { status: expected.status, ...(expectedError ? { errorCode: expectedError } : {}) },
        ok,
        ...(result.status === "parsed" ? { spanValidation: { valid: spanErrors.length === 0, spanCount: result.spans.length, errors: spanErrors } } : {}),
        ...resultDetails(result),
        ...(worker ? { worker } : {}),
      });
    }
  }

  const timeoutProbe = await runWorkerTimeoutProbe();
  const timeoutPassed = timeoutProbe.timedOut && timeoutProbe.exitCode === null && timeoutProbe.signal !== null;
  if (!timeoutPassed) failureMessages.push(`isolated worker timeout probe did not terminate as expected: ${JSON.stringify(timeoutProbe)}`);
  const forgedDocxPath = fixturePath("docx", "forged-expanded.docx");
  const forgedDocxBytes = await readFile(forgedDocxPath);
  const forgedDocxWorker = await runIsolatedParser("docx", forgedDocxBytes, { maxExpandedBytes: 512 });
  const forgedDocxPassed = forgedDocxWorker.worker.exitCode === 0
    && !forgedDocxWorker.worker.timedOut
    && forgedDocxWorker.result?.status === "failed"
    && forgedDocxWorker.result.errorCode === "EXPANDED_SIZE_LIMIT";
  if (!forgedDocxPassed) failureMessages.push(`DOCX actual inflate bound failed: ${JSON.stringify({ worker: forgedDocxWorker.worker, result: forgedDocxWorker.result && resultDetails(forgedDocxWorker.result) })}`);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    parserVersions: { "pdfjs-dist": PDFJS_VERSION, cheerio: CHEERIO_VERSION },
    configuredProductionLimits: DEFAULT_LIMITS,
    configuredWorkerLimits: { timeoutMs: 120_000, oldSpaceMiB: WORKER_OLD_SPACE_MIB, rssBytes: WORKER_RSS_LIMIT_BYTES, rssSampleIntervalMs: 100 },
    resourceTestNotes: {
      rawByteCasesUseReducedThreshold: "TXT/MD/HTML use 512 bytes to exercise the common size gate without committing 50 MiB fixtures; a separate 50 MiB + 1 byte boundary probe covers the production cap.",
      docxCaseUsesReducedExpandedThreshold: "DOCX uses a valid compressed package and a 512-byte expanded-size threshold; a forged-directory fixture verifies actual document.xml inflate output is bounded.",
      pdfCaseUsesProductionPageLimit: "PDF over-limit fixture has 501 real pages against the 500-page production limit.",
    },
    timeoutProbe: { passed: timeoutPassed, ...timeoutProbe },
    forgedDocxExpansionProbe: {
      passed: forgedDocxPassed,
      fixture: forgedDocxPath.slice(REPO_ROOT.length + 1),
      fixtureBytes: forgedDocxBytes.length,
      fixtureSha256: createHash("sha256").update(forgedDocxBytes).digest("hex"),
      configuredMaxExpandedBytes: 512,
      worker: forgedDocxWorker.worker,
      ...(forgedDocxWorker.result ? resultDetails(forgedDocxWorker.result) : {}),
    },
    summary: {
      cases: rows.length,
      passed: rows.filter((row) => row.ok === true).length,
      failed: failureMessages.length,
      normalFormatCount: rows.filter((row) => row.case === "normal" && row.status === "parsed").length,
      sourceSpanFailures: rows.filter((row) => row.spanValidation && (row.spanValidation as { valid: boolean }).valid === false).length,
    },
    cases: rows,
    failures: failureMessages,
  };

  const productionByteLimitProbe = await parseDocument("txt", Buffer.alloc(DEFAULT_LIMITS.maxBytes + 1, 0x61));
  (report as Record<string, unknown>).productionByteLimitProbe = {
    configuredBytes: DEFAULT_LIMITS.maxBytes,
    actualBytes: DEFAULT_LIMITS.maxBytes + 1,
    passed: productionByteLimitProbe.status === "failed" && productionByteLimitProbe.errorCode === "SIZE_LIMIT",
    ...resultDetails(productionByteLimitProbe),
  };
  if (productionByteLimitProbe.status !== "failed" || productionByteLimitProbe.errorCode !== "SIZE_LIMIT") {
    failureMessages.push("50 MiB + 1 byte boundary did not return SIZE_LIMIT.");
  }
  (report.summary as Record<string, unknown>).failed = failureMessages.length;
  (report.summary as Record<string, unknown>).passed = rows.filter((row) => row.ok === true).length + (productionByteLimitProbe.status === "failed" && productionByteLimitProbe.errorCode === "SIZE_LIMIT" ? 1 : 0) + (timeoutPassed ? 1 : 0) + (forgedDocxPassed ? 1 : 0);
  (report.summary as Record<string, unknown>).checks = rows.length + 3;
  (report as Record<string, unknown>).failures = failureMessages;
  return { report, failures: failureMessages };
}

async function writeDecisions(): Promise<void> {
  await mkdir(dirname(DECISIONS_PATH), { recursive: true });
  const decisions = {
    status: "recommended_after_spike",
    decisions: [
      {
        format: "PDF",
        package: "pdfjs-dist",
        version: PDFJS_VERSION,
        license: "Apache-2.0",
        entrypoint: "pdfjs-dist/legacy/build/pdf.mjs",
        reason: "Extracts text from each real PDF page and supports page-local Unicode code-point offsets.",
        limitation: "This M0 probe covers text PDFs only; scanned PDFs and OCR remain out of scope.",
      },
      {
        format: "DOCX",
        packages: [{ name: "cheerio", version: CHEERIO_VERSION, license: "MIT" }],
        builtins: ["node:zlib.inflateRawSync with maxOutputLength", "ZIP central-directory reader"],
        entrypoint: "bounded ZIP entry inflate + Cheerio XML mode",
        reason: "Reading w:p nodes directly preserves empty paragraphs and duplicate paragraph identity for the zero-based docx_paragraph locator.",
        limitation: "M0 reads text and paragraph styles from the main document part; aggregate expansion checks include ZIP declarations while actual output is bounded for document.xml, and unreferenced ZIP parts are not inflated or CRC-validated. This is not a complete ZIP bomb audit. Pagination, run styling, OCR, and full layout fidelity are also out of scope.",
      },
      {
        format: "HTML",
        package: "cheerio",
        version: CHEERIO_VERSION,
        license: "MIT",
        entrypoint: "cheerio.load",
        reason: "Tolerant HTML parsing preserves heading paths and existing fragment IDs without fabricating anchors.",
        limitation: "The probe accepts captured HTML bytes; network fetching and URL safety are separate work.",
      },
    ],
    textFormats: {
      packages: [],
      reason: "TXT/MD use Node UTF-8 decoding and line parsing, avoiding unnecessary dependencies.",
      limitation: "Markdown extraction here preserves headings and line ranges, not every dialect extension.",
    },
    rejectedAlternative: {
      package: "mammoth@1.13.0",
      reason: "Semantic HTML output may omit empty paragraphs, so its output index cannot prove the original DOCX paragraphIndex.",
      securityObservation: "Mammoth was not selected and is absent from the final parser dependency set. During selection, npm audit identified its transitive argparse -> sprintf-js <=1.1.3 finding; this probe does not import or execute Mammoth CLI code.",
    },
    acceptanceBoundary: "This report covers M0 parser evidence only; it does not claim full AC-07 or AC-22 product acceptance.",
  };
  await writeFile(DECISIONS_PATH, `${JSON.stringify(decisions, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--generate-fixtures") return generateFixtures();
  await generateFixtures();
  const { report, failures } = await runMatrix();
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  await writeDecisions();
  process.stdout.write(`${JSON.stringify({ report: REPORT_PATH, decisions: DECISIONS_PATH, summary: report.summary, failures }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
