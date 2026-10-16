import {
  DEFAULT_PARSER_LIMITS,
  parseDocument,
  type ParserFormat,
  type ParserLimits,
  type ParseFailure,
  type ParseResult,
} from './parser.js';

const format = process.argv[2] as ParserFormat;
let limits: Partial<ParserLimits> = {};
try {
  limits = process.argv[3] ? JSON.parse(process.argv[3]) as Partial<ParserLimits> : {};
} catch {
  process.stderr.write('Invalid internal parser worker options.\n');
  process.exitCode = 2;
}

if (process.exitCode !== 2) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let oversized = false;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > (limits.maxBytes ?? DEFAULT_PARSER_LIMITS.maxBytes)) {
      oversized = true;
      chunks.length = 0;
    } else if (!oversized) {
      chunks.push(chunk);
    }
  }

  let result: ParseResult;
  if (oversized) {
    const failure: ParseFailure = {
      status: 'failed',
      format,
      errorCode: 'SIZE_LIMIT',
      error: `Input has ${totalBytes} bytes; limit is ${limits.maxBytes ?? DEFAULT_PARSER_LIMITS.maxBytes}.`,
      warnings: [],
      durationMs: 0,
    };
    result = failure;
  } else {
    result = await parseDocument(format, Buffer.concat(chunks, totalBytes), limits);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
