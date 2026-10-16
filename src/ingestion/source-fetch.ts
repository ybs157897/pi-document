import {
  createPublicHtmlFetcher,
  requestPinnedAddress,
  resolvePublicHost,
  SourceFetchError,
  SOURCE_FETCH_TIMEOUT_MS,
  type FetchedHtml,
} from './source-fetch-internal.js';

const fetchPublicHtmlInternal = createPublicHtmlFetcher(resolvePublicHost, requestPinnedAddress);

export type { FetchedHtml };
export { SourceFetchError };

export async function fetchPublicHtml(url: string, signal: AbortSignal): Promise<FetchedHtml> {
  if (signal.aborted) throw new SourceFetchError('ABORTED', 'Source fetch was canceled.');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SOURCE_FETCH_TIMEOUT_MS);
  try {
    return await fetchPublicHtmlInternal(url, controller.signal);
  } catch (error) {
    if (signal.aborted) throw new SourceFetchError('ABORTED', 'Source fetch was canceled.');
    if (timedOut) throw new SourceFetchError('TIMEOUT', 'Source fetch exceeded 30 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}
