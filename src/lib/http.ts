const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15';

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} for ${url}: ${bodySnippet.slice(0, 200)}`);
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
}

export interface FetchResult {
  status: number;
  text: string;
}

// Retries on network errors and 5xx/429 with jittered backoff. 4xx (except 429) throws immediately.
export async function fetchRaw(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { method = 'GET', headers = {}, body, timeoutMs = 30_000, retries = 2 } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': DEFAULT_UA, ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.ok) return { status: res.status, text };
      if (res.status >= 500 || res.status === 429) {
        lastError = new HttpError(url, res.status, text);
        continue;
      }
      throw new HttpError(url, res.status, text);
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`fetch failed for ${url}: ${String(lastError)}`);
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { text } = await fetchRaw(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  return JSON.parse(text) as T;
}
