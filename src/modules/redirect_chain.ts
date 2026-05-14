import { fetchWithTimeout } from '../lib/http';

export interface RedirectChainResult {
  hops: RedirectHop[];
  start_url: string;
  final_url: string;
  chain_length: number;
  has_https_redirect: boolean;
  has_www_change: boolean;
  is_clean: boolean;
  issues: string[];
}

export interface RedirectHop {
  url: string;
  status: number;
  duration_ms: number;
}

export async function runRedirectChain(domain: string): Promise<RedirectChainResult> {
  const issues: string[] = [];
  const hops: RedirectHop[] = [];
  const startUrl = `http://${domain}`;
  let currentUrl = startUrl;
  let finalUrl = startUrl;
  let hasHttps = false;
  let hasWwwChange = false;

  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(currentUrl, {
        redirect: 'manual',
        timeoutMs: 5000,
      } as RequestInit & { timeoutMs?: number });

      hops.push({ url: currentUrl, status: res.status, duration_ms: Date.now() - t0 });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') ?? '';
        if (!loc) break;
        const next = loc.startsWith('http') ? loc : loc.startsWith('/') ? `${new URL(currentUrl).origin}${loc}` : loc;
        if (next.startsWith('https://')) hasHttps = true;
        const hadWww = currentUrl.includes('www.');
        const nowWww = next.includes('www.');
        if (hadWww !== nowWww) hasWwwChange = true;
        finalUrl = next;
        currentUrl = next;
      } else {
        finalUrl = currentUrl;
        break;
      }
    } catch {
      break;
    }
  }

  const redirectHops = hops.filter(h => h.status >= 300 && h.status < 400);
  const chainLength = redirectHops.length;
  const has302 = hops.some(h => h.status === 302 || h.status === 307);
  const has301 = hops.some(h => h.status === 301 || h.status === 308);

  if (chainLength > 2) issues.push(`Redirect chain has ${chainLength} hops — each hop adds ~50–100ms latency and dilutes link equity`);
  if (has302 && has301) issues.push('Mixed 301/302 redirects — temporary redirects do not fully pass PageRank');
  if (has302) issues.push('302 temporary redirect detected — use 301 for SEO-safe permanent redirects');
  if (!hasHttps && chainLength > 0) issues.push('No HTTPS upgrade in redirect chain — site may be accessible over HTTP');
  if (chainLength === 0 && hops.length > 0 && hops[0].status >= 400) issues.push(`HTTP site returns ${hops[0].status} — verify HTTP→HTTPS redirect is working`);

  return {
    hops,
    start_url: startUrl,
    final_url: finalUrl,
    chain_length: chainLength,
    has_https_redirect: hasHttps,
    has_www_change: hasWwwChange,
    is_clean: chainLength <= 1 && !has302,
    issues,
  };
}
