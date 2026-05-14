// Use a real browser UA to avoid bot-challenge pages (Cloudflare, Canva, etc.)
// Explicit bot UAs (e.g. "GeoAuditBot/1.0") cause sites to serve challenge pages
// instead of their actual content, breaking all downstream AI analysis.
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 12000;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        // Request English content so geo-redirecting sites (e.g. Stripe, Mailchimp) don't
        // return localised pages when the Cloudflare Worker edge IP is non-US.
        'Accept-Language': 'en-US,en;q=0.9',
        ...fetchOptions.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Retry once on 5xx or network error with 800ms backoff
export async function fetchWithRetry(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
  maxAttempts = 2
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetchWithTimeout(url, options);
      if (res.status < 500 || i === maxAttempts - 1) return res;
    } catch (err) {
      lastErr = err;
    }
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  throw lastErr ?? new Error(`fetch failed after ${maxAttempts} attempts`);
}

export async function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
