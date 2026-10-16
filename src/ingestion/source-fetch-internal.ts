import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { domainToASCII } from 'node:url';
import ipaddr from 'ipaddr.js';

export const SOURCE_FETCH_TIMEOUT_MS = 30_000;
export const SOURCE_FETCH_MAX_BYTES = 50 * 1024 * 1024;
export const SOURCE_FETCH_MAX_REDIRECTS = 5;

export class SourceFetchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  bytes: Buffer;
  remoteAddress: string;
}

export type SourceResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;
export type SourceTransport = (url: URL, address: PinnedAddress, signal: AbortSignal, maxBytes: number) => Promise<TransportResponse>;

export interface FetchedHtml {
  bytes: Buffer;
  mimeType: 'text/html';
  sourceUri: string;
  sha256: string;
  fetchedAt: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.tencentyun.com',
  'metadata.alibabacloud.com',
  'instance-data.ec2.internal',
]);
const BLOCKED_METADATA_IPV4 = new Set(['168.63.129.16']);

function publicAddress(rawAddress: string): PinnedAddress {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(rawAddress);
  } catch {
    throw new SourceFetchError('DNS_ADDRESS_INVALID', 'DNS returned an invalid address.');
  }
  if (parsed.kind() === 'ipv4') {
    const address = parsed as ipaddr.IPv4;
    if (address.range() !== 'unicast' || BLOCKED_METADATA_IPV4.has(address.toString())) {
      throw new SourceFetchError('IP_NOT_PUBLIC', 'URL resolved to a non-public address.');
    }
    return { address: address.toString(), family: 4 };
  }
  const address = parsed as ipaddr.IPv6;
  if (address.isIPv4MappedAddress() || address.parts.slice(0, 6).every(part => part === 0) || address.range() !== 'unicast') {
    throw new SourceFetchError('IP_NOT_PUBLIC', 'URL resolved to a non-public or encoded address.');
  }
  return { address: address.toRFC5952String(), family: 6 };
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function rawHostname(rawUrl: string): string {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(rawUrl)?.[1];
  if (!authority || authority.includes('@')) throw new SourceFetchError('URL_INVALID', 'URL authority is invalid.');
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) throw new SourceFetchError('URL_INVALID', 'IPv6 URL authority is invalid.');
    const suffix = authority.slice(close + 1);
    if (suffix && !/^:\d+$/.test(suffix)) throw new SourceFetchError('URL_INVALID', 'URL port is invalid.');
    return authority.slice(1, close);
  }
  const colon = authority.lastIndexOf(':');
  const hostname = colon >= 0 ? authority.slice(0, colon) : authority;
  if (colon >= 0 && !/^\d+$/.test(authority.slice(colon + 1))) throw new SourceFetchError('URL_INVALID', 'URL port is invalid.');
  if (!hostname || hostname.includes(':') || hostname.includes('%')) throw new SourceFetchError('URL_INVALID', 'URL hostname is invalid.');
  return hostname;
}

function validateUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8_192 || rawUrl !== rawUrl.trim()) {
    throw new SourceFetchError('URL_INVALID', 'A bounded absolute URL is required.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceFetchError('URL_INVALID', 'URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SourceFetchError('URL_SCHEME_UNSUPPORTED', 'Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password || url.hash) throw new SourceFetchError('URL_CREDENTIALS_OR_FRAGMENT', 'URL credentials and fragments are not allowed.');
  if (url.port) throw new SourceFetchError('URL_PORT_UNSUPPORTED', 'Only the default HTTP and HTTPS ports are allowed.');
  const rawHost = rawHostname(rawUrl);
  const host = unbracket(url.hostname).toLowerCase();
  if (rawHost.includes('%')) throw new SourceFetchError('URL_IP_ENCODING', 'Percent-encoded hostnames are not allowed.');
  const dnsHost = host.replace(/\.$/, '');
  if (BLOCKED_METADATA_HOSTS.has(dnsHost)
    || dnsHost === 'localhost'
    || dnsHost.endsWith('.localhost')
    || dnsHost.endsWith('.local')
    || dnsHost.endsWith('.internal')) {
    throw new SourceFetchError('URL_HOST_BLOCKED', 'Local and metadata hostnames are not allowed.');
  }

  if (ipaddr.isValid(host)) {
    const address = ipaddr.parse(host);
    if (address.kind() === 'ipv4') {
      if (rawHost.toLowerCase() !== address.toString()) throw new SourceFetchError('URL_IP_ENCODING', 'Non-canonical IPv4 host encodings are not allowed.');
    } else if ((address as ipaddr.IPv6).isIPv4MappedAddress()) {
      throw new SourceFetchError('URL_IP_ENCODING', 'IPv4-mapped IPv6 hosts are not allowed.');
    }
  } else {
    const asciiHost = domainToASCII(rawHost).toLowerCase();
    if (!asciiHost || asciiHost !== host || !host.includes('.')) {
      throw new SourceFetchError('URL_IP_ENCODING', 'Non-canonical or single-label hostnames are not allowed.');
    }
  }

  if (url.pathname.toLowerCase().endsWith('.pdf')) throw new SourceFetchError('PDF_UNSUPPORTED', 'Direct PDF sources are not supported.');
  return url;
}

function isIpLiteral(hostname: string): boolean {
  return ipaddr.isValid(unbracket(hostname));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SourceFetchError('ABORTED', 'Source fetch was canceled.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new SourceFetchError('ABORTED', 'Source fetch was canceled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function isRemoteAddressMatch(remoteAddress: string, pinned: PinnedAddress): boolean {
  try {
    let remote = ipaddr.parse(remoteAddress);
    if (remote.kind() === 'ipv6' && (remote as ipaddr.IPv6).isIPv4MappedAddress()) {
      remote = (remote as ipaddr.IPv6).toIPv4Address();
    }
    const normalized = remote.kind() === 'ipv4' ? remote.toString() : (remote as ipaddr.IPv6).toRFC5952String();
    return remote.kind() === `ipv${pinned.family}` && normalized === pinned.address;
  } catch {
    return false;
  }
}

function validateResponseHeaders(response: TransportResponse): void {
  const mediaType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') {
    if (mediaType === 'application/pdf') throw new SourceFetchError('PDF_UNSUPPORTED', 'Direct PDF sources are not supported.');
    throw new SourceFetchError('CONTENT_TYPE_UNSUPPORTED', 'Source response is not HTML.');
  }
  const encoding = response.headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') throw new SourceFetchError('CONTENT_ENCODING_UNSUPPORTED', 'Compressed source responses are not supported.');
  const declaredLength = response.headers['content-length'];
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) throw new SourceFetchError('CONTENT_LENGTH_INVALID', 'Source response length is invalid.');
    if (Number(declaredLength) > SOURCE_FETCH_MAX_BYTES) throw new SourceFetchError('RESPONSE_TOO_LARGE', 'Source response exceeds the size limit.');
  }
  if (response.bytes.length > SOURCE_FETCH_MAX_BYTES) throw new SourceFetchError('RESPONSE_TOO_LARGE', 'Source response exceeds the size limit.');
  if (/%PDF-\d\.\d/.test(response.bytes.toString('latin1', 0, Math.min(response.bytes.length, 1_024)))) {
    throw new SourceFetchError('PDF_UNSUPPORTED', 'Direct PDF sources are not supported.');
  }
}

export function createPublicHtmlFetcher(resolveHost: SourceResolver, transport: SourceTransport) {
  return async (rawUrl: string, signal: AbortSignal): Promise<FetchedHtml> => {
    let url = validateUrl(rawUrl);
    let redirects = 0;
    for (;;) {
      if (signal.aborted) throw new SourceFetchError('ABORTED', 'Source fetch was canceled.');
      const hostname = unbracket(url.hostname);
      let addresses: PinnedAddress[];
      if (isIpLiteral(hostname)) {
        addresses = [publicAddress(hostname)];
      } else {
        let resolved: string[];
        try {
          resolved = await raceAbort(resolveHost(hostname, signal), signal);
        } catch (error) {
          if (error instanceof SourceFetchError) throw error;
          throw new SourceFetchError('DNS_LOOKUP_FAILED', 'Source hostname could not be resolved.');
        }
        if (resolved.length === 0) throw new SourceFetchError('DNS_LOOKUP_FAILED', 'Source hostname returned no addresses.');
        addresses = resolved.map(publicAddress);
      }

      const pinned = addresses[0]!;
      let response: TransportResponse;
      try {
        response = await raceAbort(transport(url, pinned, signal, SOURCE_FETCH_MAX_BYTES), signal);
      } catch (error) {
        if (error instanceof SourceFetchError) throw error;
        throw new SourceFetchError('REQUEST_FAILED', 'Source request failed.');
      }
      if (!isRemoteAddressMatch(response.remoteAddress, pinned)) {
        throw new SourceFetchError('REMOTE_ADDRESS_MISMATCH', 'Connected address did not match the validated address.');
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= SOURCE_FETCH_MAX_REDIRECTS) throw new SourceFetchError('REDIRECT_LIMIT', 'Source exceeded the redirect limit.');
        const location = response.headers.location;
        if (!location) throw new SourceFetchError('REDIRECT_LOCATION_INVALID', 'Redirect response did not include a valid location.');
        try {
          url = validateUrl(new URL(location, url).toString());
        } catch (error) {
          if (error instanceof SourceFetchError) throw error;
          throw new SourceFetchError('REDIRECT_LOCATION_INVALID', 'Redirect location is invalid.');
        }
        redirects += 1;
        continue;
      }
      if (response.status !== 200) throw new SourceFetchError('HTTP_STATUS', `Source returned HTTP ${response.status}.`);
      validateResponseHeaders(response);
      return {
        bytes: response.bytes,
        mimeType: 'text/html',
        sourceUri: url.toString(),
        sha256: createHash('sha256').update(response.bytes).digest('hex'),
        fetchedAt: new Date().toISOString(),
      };
    }
  };
}

function resolveAll(hostname: string): Promise<string[]> {
  if (isIpLiteral(hostname)) return Promise.resolve([hostname]);
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map(item => item.address));
    });
  });
}

function lookupPinned(expectedHostname: string, pinned: PinnedAddress) {
  return (hostname: string, options: import('node:dns').LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | import('node:dns').LookupAddress[], family?: number) => void) => {
    if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      callback(Object.assign(new Error('Unexpected hostname lookup.'), { code: 'EHOSTUNREACH' }), '', 0);
      return;
    }
    if ('all' in options && options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function responseHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function requestPinned(url: URL, pinned: PinnedAddress, signal: AbortSignal, maxBytes: number): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finishError = (error: SourceFetchError) => {
      if (settled) return;
      settled = true;
      request?.destroy();
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => finishError(new SourceFetchError('ABORTED', 'Source fetch was canceled.'));
    const host = unbracket(url.hostname);
    const options = {
      method: 'GET',
      agent: false,
      lookup: lookupPinned(host, pinned),
      headers: {
        Accept: 'text/html',
        'Accept-Encoding': 'identity',
        'User-Agent': 'pi-document-agent/0.1',
      },
    };
    const onResponse = (response: http.IncomingMessage) => {
      const remoteAddress = response.socket.remoteAddress ?? '';
      if (!isRemoteAddressMatch(remoteAddress, pinned)) {
        finishError(new SourceFetchError('REMOTE_ADDRESS_MISMATCH', 'Connected address did not match the validated address.'));
        return;
      }
      const headers = {
        'content-type': responseHeader(response.headers['content-type']),
        'content-encoding': responseHeader(response.headers['content-encoding']),
        'content-length': responseHeader(response.headers['content-length']),
        location: responseHeader(response.headers.location),
      };
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status) || status !== 200) {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        const result = { status, headers, bytes: Buffer.alloc(0), remoteAddress };
        response.destroy();
        resolve(result);
        return;
      }
      const declared = headers['content-length'];
      if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
        finishError(new SourceFetchError('RESPONSE_TOO_LARGE', 'Source response exceeds the size limit.'));
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          finishError(new SourceFetchError('RESPONSE_TOO_LARGE', 'Source response exceeds the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', () => finishError(new SourceFetchError('REQUEST_FAILED', 'Source response stream failed.')));
      response.once('end', () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve({ status, headers, bytes: Buffer.concat(chunks, totalBytes), remoteAddress });
      });
    };
    request = url.protocol === 'https:'
      ? https.request(url, {
        ...options,
        rejectUnauthorized: true,
        servername: isIpLiteral(host) ? undefined : host,
        checkServerIdentity: tls.checkServerIdentity,
      }, onResponse)
      : http.request(url, options, onResponse);
    const verifySocket = (socket: import('node:net').Socket) => {
      const verify = () => {
        const remote = socket.remoteAddress;
        if (remote && !isRemoteAddressMatch(remote, pinned)) {
          finishError(new SourceFetchError('REMOTE_ADDRESS_MISMATCH', 'Connected address did not match the validated address.'));
        }
      };
      socket.once('connect', verify);
      socket.once('secureConnect', verify);
    };
    request.once('socket', verifySocket);
    request.once('error', () => finishError(new SourceFetchError('REQUEST_FAILED', 'Source request failed.')));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else request.end();
  });
}

export const resolvePublicHost: SourceResolver = resolveAll;
export const requestPinnedAddress: SourceTransport = requestPinned;
