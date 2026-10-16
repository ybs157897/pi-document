import { tokenize } from '../retrieval/lexical.js';
import type { ParsedSource, SourceLocator, SourceSpan } from './parser.js';

export const CHUNK_MAX_UTF8_BYTES = 768;
export const CHUNK_OVERLAP_UTF8_BYTES = 64;
export const CHUNK_TOKEN_BUDGET_STRATEGY = 'Each chunk is capped at 768 UTF-8 bytes; this is a conservative upper bound under a byte-fallback tokenizer, not an exact Qwen token count. Overlap is at most 64 UTF-8 bytes.';

export interface ChunkInput {
  ordinal: number;
  text: string;
  locator: SourceLocator;
  lexicalTokens: string[];
  startOffset: number;
  endOffset: number;
  headingPath?: string[];
}

interface SpanRange {
  start: number;
  end: number;
}

function byteLength(codePoint: string): number {
  return Buffer.byteLength(codePoint, 'utf8');
}

function isBoundary(codePoint: string): boolean {
  return /\s/u.test(codePoint) || /[,.;:!?，。！？；：、]/u.test(codePoint);
}

function splitSpan(text: string): SpanRange[] {
  const codePoints = Array.from(text);
  const byteLengths = codePoints.map(byteLength);
  const ranges: SpanRange[] = [];
  let start = 0;
  while (start < codePoints.length) {
    let end = start;
    let bytes = 0;
    while (end < codePoints.length && bytes + byteLengths[end]! <= CHUNK_MAX_UTF8_BYTES) {
      bytes += byteLengths[end]!;
      end += 1;
    }
    if (end === start) throw new RangeError('CHUNK_CODE_POINT_EXCEEDS_BYTE_BUDGET');

    if (end < codePoints.length) {
      const lowerBound = start + Math.floor((end - start) * 0.65);
      for (let candidate = end; candidate > lowerBound; candidate -= 1) {
        if (isBoundary(codePoints[candidate - 1]!)) {
          end = candidate;
          break;
        }
      }
    }
    ranges.push({ start, end });
    if (end === codePoints.length) break;

    let nextStart = end;
    let overlapBytes = 0;
    while (nextStart > start && overlapBytes + byteLengths[nextStart - 1]! <= CHUNK_OVERLAP_UTF8_BYTES) {
      nextStart -= 1;
      overlapBytes += byteLengths[nextStart]!;
    }
    start = Math.max(start + 1, nextStart);
  }
  return ranges;
}

function countNewlines(codePoints: string[]): number {
  return codePoints.reduce((count, codePoint) => count + (codePoint === '\n' ? 1 : 0), 0);
}

function locatorForRange(locator: SourceLocator, sourceText: string[], start: number, end: number, globalStart: number, globalEnd: number): SourceLocator {
  if (locator.kind === 'text_span') {
    const startLine = locator.startLine + countNewlines(sourceText.slice(0, start));
    return {
      kind: 'text_span',
      startLine,
      endLine: startLine + countNewlines(sourceText.slice(start, end)),
      startOffset: globalStart,
      endOffset: globalEnd,
    };
  }
  if (locator.kind === 'pdf_page') {
    return {
      kind: 'pdf_page',
      page: locator.page,
      startOffset: locator.startOffset + start,
      endOffset: locator.startOffset + end,
    };
  }
  return { ...locator };
}

function chunkSpan(span: SourceSpan, parsedText: string[], ordinalStart: number): ChunkInput[] {
  if (span.startOffset < 0 || span.endOffset < span.startOffset || span.endOffset > parsedText.length) {
    throw new RangeError('SOURCE_SPAN_RANGE_INVALID');
  }
  const sourceText = parsedText.slice(span.startOffset, span.endOffset);
  if (sourceText.length === 0) return [];
  const ranges = splitSpan(sourceText.join(''));
  return ranges.map(({ start, end }, index) => {
    const text = sourceText.slice(start, end).join('');
    const startOffset = span.startOffset + start;
    const endOffset = span.startOffset + end;
    return {
      ordinal: ordinalStart + index,
      text,
      locator: locatorForRange(span.locator, sourceText, start, end, startOffset, endOffset),
      lexicalTokens: tokenize(text),
      startOffset,
      endOffset,
      ...(span.headingPath ? { headingPath: [...span.headingPath] } : {}),
    };
  });
}

export function chunkDocument(parsed: ParsedSource): ChunkInput[] {
  const codePoints = Array.from(parsed.text);
  const chunks: ChunkInput[] = [];
  for (const span of parsed.spans) {
    const spanChunks = chunkSpan(span, codePoints, chunks.length);
    chunks.push(...spanChunks);
  }
  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }));
}
