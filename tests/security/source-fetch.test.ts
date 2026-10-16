import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  createPublicHtmlFetcher,
  requestPinnedAddress,
  SOURCE_FETCH_MAX_BYTES,
  SourceFetchError,
  type PinnedAddress,
  type SourceResolver,
  type SourceTransport,
  type TransportResponse,
} from '../../src/ingestion/source-fetch-internal.js';
import { fetchPublicHtml } from '../../src/ingestion/source-fetch.js';

const publicIp = '93.184.216.34';
const htmlBytes = Buffer.from('<!doctype html><html><body><h1>Fixture</h1></body></html>');

function response(pinned: PinnedAddress, overrides: Partial<TransportResponse> = {}): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(htmlBytes.length), 'content-encoding': 'identity' },
    bytes: htmlBytes,
    remoteAddress: pinned.address,
    ...overrides,
  };
}

function createFetcher(resolveHost: SourceResolver, transport: SourceTransport) {
  return createPublicHtmlFetcher(resolveHost, transport);
}

test('public fetch rejects local, private, metadata, encoded, credentialed, fragment, and PDF URLs', async () => {
  const rejectUrl = async (url: string, code?: string) => {
    await assert.rejects(fetchPublicHtml(url, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof SourceFetchError);
      if (code) assert.equal(error.code, code);
      return true;
    });
  };
  await rejectUrl('http://127.0.0.1/', 'IP_NOT_PUBLIC');
  await rejectUrl('http://10.4.3.2/', 'IP_NOT_PUBLIC');
  await rejectUrl('http://169.254.169.254/latest/meta-data/', 'IP_NOT_PUBLIC');
  await rejectUrl('http://100.64.0.8/', 'IP_NOT_PUBLIC');
  await rejectUrl('http://168.63.129.16/', 'IP_NOT_PUBLIC');
  await rejectUrl('http://2130706433/', 'URL_IP_ENCODING');
  await rejectUrl('http://0x7f000001/', 'URL_IP_ENCODING');
  await rejectUrl('http://[::ffff:7f00:1]/', 'URL_IP_ENCODING');
  await rejectUrl('http://[fd00::1]/', 'IP_NOT_PUBLIC');
  await rejectUrl('http://localhost/', 'URL_HOST_BLOCKED');
  await rejectUrl('http://metadata.google.internal/', 'URL_HOST_BLOCKED');
  await rejectUrl('file:///etc/passwd', 'URL_SCHEME_UNSUPPORTED');
  await rejectUrl('https://user:pass@example.com/', 'URL_CREDENTIALS_OR_FRAGMENT');
  await rejectUrl('https://example.com/#fragment', 'URL_CREDENTIALS_OR_FRAGMENT');
  await rejectUrl('https://example.com/files/report.PDF', 'PDF_UNSUPPORTED');
});

test('low-level transport uses its pinned lookup and checks the connected address', async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    assert.equal(request.headers.host?.split(':')[0], 'public-fixture.example');
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(htmlBytes.length) });
    response.end(htmlBytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    // This low-level fixture bypasses public-address validation only to exercise Node's custom lookup without contacting the internet.
    const result = await requestPinnedAddress(
      new URL(`http://public-fixture.example:${address.port}/page`),
      { address: '127.0.0.1', family: 4 },
      AbortSignal.timeout(5_000),
      1_024,
    );
    assert.equal(requestCount, 1);
    assert.equal(result.remoteAddress, '127.0.0.1');
    assert.deepEqual(result.bytes, htmlBytes);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('DNS results must all be public and each redirect performs a fresh pinned lookup', async () => {
  let transportCalls = 0;
  const mixed = createFetcher(async () => [publicIp, '127.0.0.1'], async () => {
    transportCalls += 1;
    return response({ address: publicIp, family: 4 });
  });
  await assert.rejects(mixed('https://docs.example.com/', new AbortController().signal), (error: unknown) => error instanceof SourceFetchError && error.code === 'IP_NOT_PUBLIC');
  assert.equal(transportCalls, 0);

  let resolverCalls = 0;
  let requestCalls = 0;
  const rebinding = createFetcher(async () => {
    resolverCalls += 1;
    return resolverCalls === 1 ? [publicIp] : [publicIp, '127.0.0.1'];
  }, async (url, pinned) => {
    requestCalls += 1;
    assert.equal(pinned.address, publicIp);
    assert.equal(url.pathname, '/start');
    return response(pinned, {
      status: 302,
      headers: { location: '/next', 'content-length': '0' },
      bytes: Buffer.alloc(0),
    });
  });
  await assert.rejects(rebinding('https://docs.example.com/start', new AbortController().signal), (error: unknown) => error instanceof SourceFetchError && error.code === 'IP_NOT_PUBLIC');
  assert.equal(resolverCalls, 2);
  assert.equal(requestCalls, 1);
});

test('redirects are bounded to five and each connection reports the pinned remote address', async () => {
  let requests = 0;
  let lookups = 0;
  const fiveRedirects = createFetcher(async () => {
    lookups += 1;
    return [publicIp];
  }, async (_url, pinned) => {
    requests += 1;
    return requests <= 5
      ? response(pinned, { status: 302, headers: { location: `/step-${requests}`, 'content-length': '0' }, bytes: Buffer.alloc(0) })
      : response(pinned);
  });
  const fetched = await fiveRedirects('https://docs.example.com/start', AbortSignal.timeout(5_000));
  assert.equal(requests, 6);
  assert.equal(lookups, 6);
  assert.equal(fetched.sourceUri, 'https://docs.example.com/step-5');
  assert.equal(fetched.mimeType, 'text/html');
  assert.equal(fetched.sha256.length, 64);
  assert.ok(Number.isFinite(Date.parse(fetched.fetchedAt)));

  let overLimitCalls = 0;
  const tooMany = createFetcher(async () => [publicIp], async (url, pinned) => {
    overLimitCalls += 1;
    return response(pinned, { status: 302, headers: { location: `${url.pathname}/again` }, bytes: Buffer.alloc(0) });
  });
  await assert.rejects(tooMany('https://docs.example.com/start', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'REDIRECT_LIMIT');
  assert.equal(overLimitCalls, 6);

  const mismatch = createFetcher(async () => [publicIp], async () => response({ address: publicIp, family: 4 }, { remoteAddress: '10.0.0.2' }));
  await assert.rejects(mismatch('https://docs.example.com/', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'REMOTE_ADDRESS_MISMATCH');
});

test('non-HTML, compressed, PDF, oversized, and canceled responses are rejected', async () => {
  const resolver: SourceResolver = async () => [publicIp];
  const fetchWith = (transport: SourceTransport) => createFetcher(resolver, transport);
  const pinned = { address: publicIp, family: 4 } as const;

  await assert.rejects(fetchWith(async () => response(pinned, { headers: { 'content-type': 'application/pdf' } }))('https://docs.example.com/', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'PDF_UNSUPPORTED');
  await assert.rejects(fetchWith(async () => response(pinned, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }))('https://docs.example.com/', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'CONTENT_ENCODING_UNSUPPORTED');
  await assert.rejects(fetchWith(async () => response(pinned, { headers: { 'content-type': 'text/plain' } }))('https://docs.example.com/', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'CONTENT_TYPE_UNSUPPORTED');
  await assert.rejects(fetchWith(async () => response(pinned, { headers: { 'content-type': 'text/html', 'content-length': String(SOURCE_FETCH_MAX_BYTES + 1) } }))('https://docs.example.com/', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'RESPONSE_TOO_LARGE');

  const largeBytes = Buffer.alloc(SOURCE_FETCH_MAX_BYTES + 1);
  await assert.rejects(fetchWith(async () => response(pinned, { bytes: largeBytes, headers: { 'content-type': 'text/html' } }))('https://docs.example.com/', AbortSignal.timeout(5_000)), (error: unknown) => error instanceof SourceFetchError && error.code === 'RESPONSE_TOO_LARGE');

  const controller = new AbortController();
  const blocked = fetchWith(async (_url, _address, signal) => new Promise<TransportResponse>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new SourceFetchError('ABORTED', 'Source fetch was canceled.')), { once: true });
  }));
  const fetchPromise = blocked('https://docs.example.com/', controller.signal);
  controller.abort();
  await assert.rejects(fetchPromise, (error: unknown) => error instanceof SourceFetchError && error.code === 'ABORTED');
});
