import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { load } from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parserWorkerCommand, ParserNetworkIsolationError } from './parser-sandbox.js';
const pdfAssetsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

export type ParserFormat = "txt" | "md" | "pdf" | "docx" | "html";

export type SourceLocator =
  | {
      kind: "text_span";
      startLine: number;
      endLine: number;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "pdf_page";
      page: number;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "docx_paragraph";
      headingPath: string[];
      paragraphIndex: number;
    }
  | {
      kind: "html_section";
      headingPath: string[];
      fragment: string;
    };

export interface SourceSpan {
  /** Global offsets into normalizedText in Unicode code points; PDF locators also carry page-local offsets. */
  startOffset: number;
  endOffset: number;
  headingPath?: string[];
  locator: SourceLocator;
}

export interface ParseSuccess {
  status: "parsed";
  format: ParserFormat;
  normalizedText: string;
  spans: SourceSpan[];
  warnings: string[];
  durationMs: number;
}

export interface ParseFailure {
  status: "failed";
  format: ParserFormat;
  errorCode:
    | "EMPTY_INPUT"
    | "EMPTY_PARSE"
    | "CORRUPT_DOCUMENT"
    | "SIZE_LIMIT"
    | "EXPANDED_SIZE_LIMIT"
    | "PAGE_LIMIT"
    | "UNSUPPORTED_FORMAT"
    | "PARSER_NETWORK_ISOLATION_UNAVAILABLE";
  error: string;
  warnings: string[];
  durationMs: number;
}

export type ParseResult = ParseSuccess | ParseFailure;

export interface ParserLimits {
  maxBytes: number;
  maxExpandedBytes: number;
  maxPdfPages: number;
}

export const DEFAULT_PARSER_LIMITS: Readonly<ParserLimits> = Object.freeze({
  maxBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxPdfPages: 500,
});
const WORKER_OLD_SPACE_MIB = 512;
const WORKER_RSS_LIMIT_BYTES = 1024 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 120_000;
const WORKER_RSS_POLL_MS = 100;
const WORKER_OUTPUT_LIMIT_BYTES = 120 * 1024 * 1024;
const execFileAsync = promisify(execFile);
class ParseError extends Error {
  constructor(
    readonly errorCode: ParseFailure["errorCode"],
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

function decodeUtf8(input: Buffer): string {
  try {
    return normalizeNewlines(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    throw new ParseError("CORRUPT_DOCUMENT", "Input is not valid UTF-8.");
  }
}

function failed(
  format: ParserFormat,
  errorCode: ParseFailure["errorCode"],
  error: string,
  startedAt: number,
  warnings: string[] = [],
): ParseFailure {
  return {
    status: "failed",
    format,
    errorCode,
    error,
    warnings,
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
  };
}

function spanFromText(
  normalizedText: string,
  blocks: Array<{ startLine: number; endLine: number; text: string; headingPath?: string[] }>,
): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const lineStarts: number[] = [0];
  const normalizedLines = normalizedText.split("\n");
  for (let index = 0; index < normalizedLines.length - 1; index += 1) {
    lineStarts.push(lineStarts[index]! + codePointLength(normalizedLines[index]!) + 1);
  }
  for (const block of blocks) {
    const startOffset = lineStarts[block.startLine - 1] ?? 0;
    const endOffset = startOffset + codePointLength(block.text);
    spans.push({
      startOffset,
      endOffset,
      ...(block.headingPath ? { headingPath: [...block.headingPath] } : {}),
      locator: {
        kind: "text_span",
        startLine: block.startLine,
        endLine: block.endLine,
        startOffset,
        endOffset,
      },
    });
  }
  return spans;
}

function parseText(format: "txt" | "md", input: Buffer): Pick<ParseSuccess, "normalizedText" | "spans"> {
  const source = decodeUtf8(input);
  const lines = source.split("\n");
  const headingStack: string[] = [];
  const outputLines: string[] = [];
  const blocks: Array<{ startLine: number; endLine: number; text: string; headingPath?: string[] }> = [];
  let activeBlock: { startLine: number; endLine: number; lines: string[]; headingPath?: string[] } | undefined;
  const flush = () => {
    if (!activeBlock) return;
    blocks.push({
      startLine: activeBlock.startLine,
      endLine: activeBlock.endLine,
      text: activeBlock.lines.join("\n"),
      ...(activeBlock.headingPath ? { headingPath: [...activeBlock.headingPath] } : {}),
    });
    activeBlock = undefined;
  };

  lines.forEach((rawLine, index) => {
    let text = rawLine;
    let headingPath: string[] | undefined;
    let isHeading = false;
    if (format === "md") {
      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine);
      if (heading) {
        isHeading = true;
        const level = heading[1]!.length;
        const title = heading[2]!.trim();
        headingStack.splice(level - 1);
        headingStack[level - 1] = title;
        text = title;
        headingPath = headingStack.filter((part): part is string => Boolean(part));
      } else {
        headingPath = headingStack.filter((part): part is string => Boolean(part));
      }
    }
    outputLines.push(text);
    const lineNumber = index + 1;
    if (!text.trim()) {
      flush();
      return;
    }
    if (isHeading) flush();
    const pathMatches = JSON.stringify(activeBlock?.headingPath ?? []) === JSON.stringify(headingPath ?? []);
    if (!activeBlock || activeBlock.endLine !== lineNumber - 1 || !pathMatches || isHeading) {
      flush();
      activeBlock = { startLine: lineNumber, endLine: lineNumber, lines: [text], ...(headingPath ? { headingPath: [...headingPath] } : {}) };
    } else {
      activeBlock.endLine = lineNumber;
      activeBlock.lines.push(text);
    }
    if (isHeading) flush();
  });
  flush();

  const normalizedText = outputLines.join("\n");
  return { normalizedText, spans: spanFromText(normalizedText, blocks) };
}

interface DocxZipEntry {
  name: string;
  compressionMethod: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  centralDirectoryOffset: number;
}

const DOCX_CRC_TABLE = (() => {
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
  for (const byte of data) value = DOCX_CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function inspectDocxArchive(input: Buffer): { expandedBytes: number; entries: Map<string, DocxZipEntry> } {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, input.length - 22 - 0xffff);
  let endRecord = -1;
  for (let offset = input.length - 22; offset >= minOffset; offset -= 1) {
    if (input.readUInt32LE(offset) === signature) {
      const commentLength = input.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === input.length) {
        endRecord = offset;
        break;
      }
    }
  }
  if (endRecord < 0) throw new ParseError("CORRUPT_DOCUMENT", "DOCX ZIP end record is missing.");

  const entryCount = input.readUInt16LE(endRecord + 10);
  const entriesOnDisk = input.readUInt16LE(endRecord + 8);
  const diskNumber = input.readUInt16LE(endRecord + 4);
  const centralDiskNumber = input.readUInt16LE(endRecord + 6);
  const centralDirectorySize = input.readUInt32LE(endRecord + 12);
  const centralDirectoryOffset = input.readUInt32LE(endRecord + 16);
  if (diskNumber !== 0 || centralDiskNumber !== 0 || entriesOnDisk !== entryCount) {
    throw new ParseError("UNSUPPORTED_FORMAT", "Multi-disk DOCX ZIP archives are unsupported.");
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new ParseError("CORRUPT_DOCUMENT", "ZIP64 DOCX packages are outside this M0 parser probe.");
  }
  if (centralDirectoryOffset + centralDirectorySize > endRecord) {
    throw new ParseError("CORRUPT_DOCUMENT", "DOCX ZIP central directory is out of bounds.");
  }

  let offset = centralDirectoryOffset;
  let expandedBytes = 0;
  const entries = new Map<string, DocxZipEntry>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryOffset + centralDirectorySize || input.readUInt32LE(offset) !== 0x02014b50) {
      throw new ParseError("CORRUPT_DOCUMENT", "DOCX ZIP central directory entry is malformed.");
    }
    const diskStart = input.readUInt16LE(offset + 34);
    const flags = input.readUInt16LE(offset + 8);
    const checksum = input.readUInt32LE(offset + 16);
    const compressedSize = input.readUInt32LE(offset + 20);
    const uncompressedSize = input.readUInt32LE(offset + 24);
    const nameLength = input.readUInt16LE(offset + 28);
    const extraLength = input.readUInt16LE(offset + 30);
    const commentLength = input.readUInt16LE(offset + 32);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralDirectoryOffset + centralDirectorySize) {
      throw new ParseError("CORRUPT_DOCUMENT", "DOCX ZIP directory entry exceeds the directory bounds.");
    }
    const name = input.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (entries.has(name)) throw new ParseError("CORRUPT_DOCUMENT", `DOCX contains duplicate ZIP entry ${name}.`);
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ParseError("CORRUPT_DOCUMENT", "Multi-disk or ZIP64 DOCX packages are outside this M0 parser probe.");
    }
    if ((flags & (0x1 | 0x40 | 0x2000)) !== 0) throw new ParseError("UNSUPPORTED_FORMAT", "Encrypted DOCX ZIP entries are unsupported.");
    entries.set(name, {
      name,
      compressionMethod: input.readUInt16LE(offset + 10),
      flags,
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset: input.readUInt32LE(offset + 42),
      centralDirectoryOffset,
    });
    expandedBytes += uncompressedSize;
    if (!Number.isSafeInteger(expandedBytes)) {
      throw new ParseError("EXPANDED_SIZE_LIMIT", "DOCX expanded size cannot be represented safely.");
    }
    offset = recordEnd;
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize || !entries.has("word/document.xml")) {
    throw new ParseError("CORRUPT_DOCUMENT", "DOCX document part or central directory is missing.");
  }
  return { expandedBytes, entries };
}

function pdfPageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let result = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    result += item.str;
    if (item.hasEOL) result += "\n";
  }
  return result.replace(/\n+$/g, "").trim();
}

function readDocxEntryBounded(input: Buffer, entry: DocxZipEntry, maxBytes: number): Buffer {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > input.length || input.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new ParseError("CORRUPT_DOCUMENT", `DOCX local header for ${entry.name} is invalid.`);
  }
  const localMethod = input.readUInt16LE(localOffset + 8);
  const localFlags = input.readUInt16LE(localOffset + 6);
  const localNameLength = input.readUInt16LE(localOffset + 26);
  const localExtraLength = input.readUInt16LE(localOffset + 28);
  if (localOffset + 30 + localNameLength + localExtraLength > input.length) {
    throw new ParseError("CORRUPT_DOCUMENT", `DOCX local entry ${entry.name} header is truncated.`);
  }
  const localName = input.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (localMethod !== entry.compressionMethod || localFlags !== entry.flags || localName !== entry.name || dataEnd > entry.centralDirectoryOffset) {
    throw new ParseError("CORRUPT_DOCUMENT", `DOCX local entry ${entry.name} disagrees with its central directory.`);
  }
  const compressed = input.subarray(dataOffset, dataEnd);
  let expanded: Buffer;
  if (entry.compressionMethod === 0) {
    if (compressed.length > maxBytes) throw new ParseError("EXPANDED_SIZE_LIMIT", `DOCX entry ${entry.name} expands past ${maxBytes} bytes.`);
    expanded = Buffer.from(compressed);
  } else if (entry.compressionMethod === 8) {
    try {
      expanded = inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ParseError("EXPANDED_SIZE_LIMIT", `DOCX entry ${entry.name} expands past ${maxBytes} bytes.`);
      }
      throw new ParseError("CORRUPT_DOCUMENT", error instanceof Error ? error.message : `DOCX entry ${entry.name} could not be inflated.`);
    }
  } else {
    throw new ParseError("UNSUPPORTED_FORMAT", `DOCX compression method ${entry.compressionMethod} is unsupported.`);
  }
  if (expanded.length > maxBytes) throw new ParseError("EXPANDED_SIZE_LIMIT", `DOCX entry ${entry.name} expands past ${maxBytes} bytes.`);
  if (expanded.length !== entry.uncompressedSize || crc32(expanded) !== entry.crc32) {
    throw new ParseError("CORRUPT_DOCUMENT", `DOCX entry ${entry.name} size or checksum is invalid.`);
  }
  return expanded;
}

async function parsePdf(input: Buffer, limits: ParserLimits): Promise<Pick<ParseSuccess, "normalizedText" | "spans" | "warnings">> {
  if (input.length < 8 || input.toString("ascii", 0, 5) !== "%PDF-") {
    throw new ParseError("CORRUPT_DOCUMENT", "PDF header is missing.");
  }
  const loadingTask = getDocument({
    data: new Uint8Array(input),
    disableFontFace: true,
    useSystemFonts: true,
    cMapUrl: join(pdfAssetsRoot, 'cmaps') + sep,
    cMapPacked: true,
    standardFontDataUrl: join(pdfAssetsRoot, 'standard_fonts') + sep,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages > limits.maxPdfPages) {
      throw new ParseError("PAGE_LIMIT", `PDF has ${document.numPages} pages; limit is ${limits.maxPdfPages}.`);
    }
    const pageTexts: string[] = [];
    const spans: SourceSpan[] = [];
    const warnings: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = pdfPageText(content.items.filter((item): item is typeof item & { str: string } => "str" in item));
      pageTexts.push(pageText);
      const pageLength = codePointLength(pageText);
      if (pageLength > 0) {
        const normalizedStart = pageTexts.slice(0, pageNumber - 1).reduce((offset, text) => offset + codePointLength(text), 0) + (pageNumber > 1 ? 2 * (pageNumber - 1) : 0);
        spans.push({
          startOffset: normalizedStart,
          endOffset: normalizedStart + pageLength,
          locator: { kind: "pdf_page", page: pageNumber, startOffset: 0, endOffset: pageLength },
        });
      }
      page.cleanup();
    }
    const normalizedText = pageTexts.join("\n\n");
    if (spans.length === 0) warnings.push("PDF pages were readable but contained no extractable text.");
    return { normalizedText, spans, warnings };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("CORRUPT_DOCUMENT", error instanceof Error ? error.message : "PDF parsing failed.");
  } finally {
    await loadingTask.destroy();
  }
}

function normalizeBlock(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseHtml(input: Buffer): Pick<ParseSuccess, "normalizedText" | "spans"> {
  const source = decodeUtf8(input);
  const $ = load(source);
  const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th";
  const blocks = $("body").find(blockSelector).toArray().filter((node) => $(node).parentsUntil("body", blockSelector).length === 0);
  const headingStack: string[] = [];
  const fragmentStack: string[] = [];
  const pieces: string[] = [];
  const spans: SourceSpan[] = [];

  const append = (text: string, headingPath: string[], fragment: string) => {
    const startOffset = pieces.length === 0 ? 0 : codePointLength(pieces.join("\n")) + 1;
    const endOffset = startOffset + codePointLength(text);
    pieces.push(text);
    spans.push({
      startOffset,
      endOffset,
      locator: { kind: "html_section", headingPath: [...headingPath], fragment },
    });
  };

  for (const node of blocks) {
    const tagName = (node as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const text = normalizeBlock($(node).text());
    if (!text) continue;
    const heading = /^h([1-6])$/.exec(tagName);
    if (heading) {
      const level = Number(heading[1]);
      headingStack.splice(level - 1);
      fragmentStack.splice(level - 1);
      headingStack[level - 1] = text;
      const explicitId = $(node).attr("id");
      fragmentStack[level - 1] = explicitId ?? "";
      append(text, headingStack.filter(Boolean), fragmentStack[fragmentStack.length - 1] ?? "");
      continue;
    }
    append(text, headingStack.filter(Boolean), fragmentStack[fragmentStack.length - 1] ?? "");
  }

  if (spans.length === 0) {
    const fallback = normalizeBlock($("body").text());
    if (fallback) append(fallback, [], "");
  }
  return { normalizedText: pieces.join("\n"), spans };
}

async function parseDocx(input: Buffer, limits: ParserLimits): Promise<Pick<ParseSuccess, "normalizedText" | "spans" | "warnings">> {
  const archive = inspectDocxArchive(input);
  const expandedBytes = archive.expandedBytes;
  if (expandedBytes > limits.maxExpandedBytes) {
    throw new ParseError("EXPANDED_SIZE_LIMIT", `DOCX expands to ${expandedBytes} bytes; limit is ${limits.maxExpandedBytes}.`);
  }
  const documentPart = archive.entries.get("word/document.xml");
  if (!documentPart) throw new ParseError("CORRUPT_DOCUMENT", "DOCX document.xml is missing.");
  const documentXml = readDocxEntryBounded(input, documentPart, limits.maxExpandedBytes);
  let $: ReturnType<typeof load>;
  try {
    $ = load(decodeUtf8(documentXml), { xmlMode: true });
  } catch (error) {
    throw new ParseError("CORRUPT_DOCUMENT", error instanceof Error ? error.message : "DOCX document XML is invalid.");
  }
  const $body = $("w\\:document > w\\:body").first();
  if ($body.length === 0) throw new ParseError("CORRUPT_DOCUMENT", "DOCX document body is missing.");
  const paragraphs = $body.find("w\\:p").toArray();
  const headingStack: string[] = [];
  const pieces: string[] = [];
  const spans: SourceSpan[] = [];
  let paragraphIndex = 0;
  for (const paragraph of paragraphs) {
    const $paragraph = $(paragraph);
    const styleId = $paragraph.children("w\\:pPr").find("w\\:pStyle").first().attr("w:val") ?? "";
    const textNodes = $paragraph.find("w\\:t,w\\:tab,w\\:br,w\\:cr").toArray();
    const rawText = textNodes.map((node) => {
      const name = (node as { name?: string }).name ?? "";
      if (name.endsWith(":tab")) return "\t";
      if (name.endsWith(":br") || name.endsWith(":cr")) return "\n";
      return $(node).text();
    }).join("");
    const text = normalizeBlock(rawText);
    const heading = /^heading\s*([1-6])$/i.exec(styleId);
    if (heading) {
      const level = Number(heading[1]);
      headingStack.splice(level - 1);
      headingStack[level - 1] = text;
    }
    if (text) {
      const startOffset = pieces.length === 0 ? 0 : codePointLength(pieces.join("\n")) + 1;
      const endOffset = startOffset + codePointLength(text);
      pieces.push(text);
      spans.push({
        startOffset,
        endOffset,
        locator: {
          kind: "docx_paragraph",
          headingPath: headingStack.filter(Boolean),
          paragraphIndex,
        },
      });
    }
    paragraphIndex += 1;
  }
  return {
    normalizedText: pieces.join("\n"),
    spans,
    warnings: [],
  };
}

export async function parseDocument(
  format: ParserFormat,
  input: Buffer,
  overrides: Partial<ParserLimits> = {},
): Promise<ParseResult> {
  const startedAt = performance.now();
  const limits = { ...DEFAULT_PARSER_LIMITS, ...overrides };
  if (input.length === 0) return failed(format, "EMPTY_INPUT", "Input file is empty.", startedAt);
  if (input.length > limits.maxBytes) {
    return failed(format, "SIZE_LIMIT", `Input has ${input.length} bytes; limit is ${limits.maxBytes}.`, startedAt);
  }

  try {
    let parsed: Pick<ParseSuccess, "normalizedText" | "spans"> & { warnings?: string[] };
    switch (format) {
      case "txt":
      case "md":
        parsed = parseText(format, input);
        break;
      case "pdf":
        parsed = await parsePdf(input, limits);
        break;
      case "docx":
        parsed = await parseDocx(input, limits);
        break;
      case "html":
        parsed = parseHtml(input);
        break;
      default:
        return failed(format, "UNSUPPORTED_FORMAT", `Unsupported parser format: ${String(format)}.`, startedAt);
    }
    if (parsed.normalizedText.trim().length === 0 || parsed.spans.length === 0) {
      return failed(format, "EMPTY_PARSE", "Parser produced no non-empty source spans.", startedAt, parsed.warnings ?? []);
    }
    return {
      status: "parsed",
      format,
      normalizedText: parsed.normalizedText,
      spans: parsed.spans,
      warnings: parsed.warnings ?? [],
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
    };
  } catch (error) {
    if (error instanceof ParseError) return failed(format, error.errorCode, error.message, startedAt);
    return failed(format, "CORRUPT_DOCUMENT", error instanceof Error ? error.message : "Parser failed.", startedAt);
  }
}

export interface ParsedSource {
  text: string;
  spans: SourceSpan[];
  warnings: string[];
}

export class ParserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ParserError';
  }
}

function formatForMime(mime: string): ParserFormat {
  const mediaType = mime.split(';', 1)[0]?.trim().toLowerCase();
  switch (mediaType) {
    case 'text/plain': return 'txt';
    case 'text/markdown':
    case 'text/x-markdown': return 'md';
    case 'application/pdf': return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'text/html': return 'html';
    default: throw new ParserError('UNSUPPORTED_FORMAT', `Unsupported media type: ${mediaType || '(empty)'}.`);
  }
}

async function processRssBytes(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      return value ? Number(value) * 1024 : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 500 });
      const value = Number(stdout.trim());
      return Number.isFinite(value) ? value * 1024 : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function abortedParserError(): ParserError {
  return new ParserError('PARSER_ABORTED', 'Parsing was canceled.');
}

async function parseHeavyFormatInWorker(
  format: ParserFormat,
  input: Buffer,
  signal?: AbortSignal,
): Promise<ParseResult> {
  if (signal?.aborted) throw abortedParserError();
  const workerPath = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './parser-worker.ts' : './parser-worker.js', import.meta.url));
  const args = [
    `--max-old-space-size=${WORKER_OLD_SPACE_MIB}`,
    ...(workerPath.endsWith('.ts') ? ['--import', 'tsx'] : []),
    workerPath,
    format,
  ];
  let isolatedCommand: { command: string; args: string[] };
  try {
    isolatedCommand = await parserWorkerCommand(process.platform, process.execPath, args);
  } catch (error) {
    if (error instanceof ParserNetworkIsolationError) {
      throw new ParserError('PARSER_NETWORK_ISOLATION_UNAVAILABLE', 'Heavy document parsing requires verified per-process network isolation.');
    }
    throw error;
  }
  const child = spawn(isolatedCommand.command, isolatedCommand.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8', TZ: 'UTC',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
  });
  let stdout = '';
  let outputBytes = 0;
  let failure: ParserError | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let monitorBusy = false;
  let closed = false;
  const terminate = (error: ParserError) => {
    if (failure || closed) return;
    failure = error;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
  };
  const onAbort = () => terminate(abortedParserError());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk, 'utf8');
    if (outputBytes > WORKER_OUTPUT_LIMIT_BYTES) {
      terminate(new ParserError('PARSER_OUTPUT_LIMIT', 'Parser worker output exceeded its limit.'));
      return;
    }
    stdout += chunk;
  });
  child.stderr.on('data', () => undefined);
  child.stdin.on('error', () => undefined);
  child.once('error', () => terminate(new ParserError('PARSER_WORKER_FAILED', 'Parser worker could not be started.')));
  const timeout = setTimeout(() => terminate(new ParserError('PARSER_TIMEOUT', 'Parser worker exceeded 120 seconds.')), WORKER_TIMEOUT_MS);
  const memoryMonitor = setInterval(async () => {
    if (!child.pid || monitorBusy || closed) return;
    monitorBusy = true;
    const rss = await processRssBytes(child.pid);
    monitorBusy = false;
    if (rss !== undefined && rss > WORKER_RSS_LIMIT_BYTES) {
      terminate(new ParserError('PARSER_MEMORY_LIMIT', 'Parser worker exceeded its RSS limit.'));
    }
  }, WORKER_RSS_POLL_MS);

  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.once('close', (code, closeSignal) => {
      closed = true;
      resolveClose({ code, signal: closeSignal });
    });
  });
  if (!failure) child.stdin.end(input);
  const closeResult = await close.finally(() => {
    clearTimeout(timeout);
    clearInterval(memoryMonitor);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
  });
  if (failure) throw failure;
  if (closeResult.code !== 0) {
    throw new ParserError('PARSER_WORKER_FAILED', `Parser worker exited with ${closeResult.signal ?? closeResult.code}.`);
  }
  try {
    return JSON.parse(stdout.trim()) as ParseResult;
  } catch {
    throw new ParserError('PARSER_WORKER_FAILED', 'Parser worker returned invalid JSON.');
  }
}

export async function parseSource(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<ParsedSource> {
  if (signal?.aborted) throw abortedParserError();
  if (bytes.byteLength > DEFAULT_PARSER_LIMITS.maxBytes) {
    throw new ParserError('SIZE_LIMIT', `Input has ${bytes.byteLength} bytes; limit is ${DEFAULT_PARSER_LIMITS.maxBytes}.`);
  }
  const format = formatForMime(mime);
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const result = format === 'pdf' || format === 'docx' || format === 'html'
    ? await parseHeavyFormatInWorker(format, input, signal)
    : await parseDocument(format, input);
  if (signal?.aborted) throw abortedParserError();
  if (result.status === 'failed') throw new ParserError(result.errorCode, result.error);
  return { text: result.normalizedText, spans: result.spans, warnings: result.warnings };
}
