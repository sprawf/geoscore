/**
 * Lighthouse / PageSpeed Insights module
 * Uses the free Google PageSpeed Insights API (25,000 req/day)
 * Returns lab performance scores + Core Web Vitals for mobile & desktop
 */

export interface LighthouseResult {
  mobile_score: number | null;
  desktop_score: number | null;
  // Core Web Vitals — lab data, mobile
  lcp_ms: number | null;
  cls: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
  si_ms: number | null;
  // Core Web Vitals — lab data, desktop
  desktop_lcp_ms: number | null;
  desktop_cls: number | null;
  desktop_fcp_ms: number | null;
  // Actionable counts
  opportunities: number;
  // Module-level score (0-100)
  score: number;
  issues: string[];
}

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

async function fetchPsi(
  url: string,
  strategy: 'mobile' | 'desktop',
  apiKey: string,
): Promise<{ data: unknown; status: number; error?: string }> {
  const endpoint = `${PSI_BASE}?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${apiKey}&category=performance`;
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(28000) });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        data: null,
        status: res.status,
        error: body?.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return { data: body, status: res.status };
  } catch (e: unknown) {
    return { data: null, status: 0, error: String(e) };
  }
}

function extractScore(data: unknown): number | null {
  const d = data as Record<string, any>;
  const s = d?.lighthouseResult?.categories?.performance?.score;
  return s != null ? Math.round(Number(s) * 100) : null;
}

function numericAudit(data: unknown, id: string): number | null {
  const d = data as Record<string, any>;
  const v = d?.lighthouseResult?.audits?.[id]?.numericValue;
  return v != null ? Number(v) : null;
}

function countOpportunities(data: unknown): number {
  const d = data as Record<string, any>;
  const audits = d?.lighthouseResult?.audits;
  if (!audits) return 0;
  return Object.values(audits as Record<string, any>).filter(
    (a: any) => a?.details?.type === 'opportunity' && (a?.details?.overallSavingsMs ?? 0) > 150
  ).length;
}

export async function runLighthouse(domain: string, apiKey: string): Promise<LighthouseResult> {
  if (!apiKey) throw new Error('PAGESPEED_API_KEY not configured');

  const pageUrl = `https://${domain}`;

  // Run mobile and desktop in parallel
  const [mobileRes, desktopRes] = await Promise.all([
    fetchPsi(pageUrl, 'mobile', apiKey),
    fetchPsi(pageUrl, 'desktop', apiKey),
  ]);

  // Surface API errors as issues for easier debugging
  const apiErrors: string[] = [];
  if (mobileRes.error)  apiErrors.push(`PSI mobile: ${mobileRes.error} (HTTP ${mobileRes.status})`);
  if (desktopRes.error) apiErrors.push(`PSI desktop: ${desktopRes.error} (HTTP ${desktopRes.status})`);

  const mobile  = mobileRes.data;
  const desktop = desktopRes.data;

  const mobileScore = extractScore(mobile);
  const desktopScore = extractScore(desktop);

  const lcpMs  = numericAudit(mobile, 'largest-contentful-paint');
  const cls    = numericAudit(mobile, 'cumulative-layout-shift');
  const fcpMs  = numericAudit(mobile, 'first-contentful-paint');
  const tbtMs  = numericAudit(mobile, 'total-blocking-time');
  const siMs   = numericAudit(mobile, 'speed-index');

  const issues: string[] = [...apiErrors];
  if (lcpMs != null) {
    if (lcpMs > 4000)       issues.push(`LCP ${(lcpMs / 1000).toFixed(1)}s mobile — poor (>4s)`);
    else if (lcpMs > 2500)  issues.push(`LCP ${(lcpMs / 1000).toFixed(1)}s mobile — needs improvement`);
  }
  if (cls != null) {
    if (cls > 0.25)         issues.push(`CLS ${cls.toFixed(3)} mobile — poor (>0.25)`);
    else if (cls > 0.1)     issues.push(`CLS ${cls.toFixed(3)} mobile — needs improvement`);
  }
  if (tbtMs != null && tbtMs > 600) {
    issues.push(`Total Blocking Time ${Math.round(tbtMs)}ms mobile — high JS blocking`);
  }
  if (mobileScore != null && mobileScore < 50) {
    issues.push(`Mobile performance score ${mobileScore}/100 — poor`);
  }

  // Module score: mobile weighted 60%, desktop 40% (mobile-first world)
  const moduleScore =
    mobileScore !== null && desktopScore !== null
      ? Math.round(mobileScore * 0.6 + desktopScore * 0.4)
      : mobileScore ?? desktopScore ?? 0;

  return {
    mobile_score:    mobileScore,
    desktop_score:   desktopScore,
    lcp_ms:          lcpMs,
    cls,
    fcp_ms:          fcpMs,
    tbt_ms:          tbtMs,
    si_ms:           siMs,
    desktop_lcp_ms:  numericAudit(desktop, 'largest-contentful-paint'),
    desktop_cls:     numericAudit(desktop, 'cumulative-layout-shift'),
    desktop_fcp_ms:  numericAudit(desktop, 'first-contentful-paint'),
    opportunities:   countOpportunities(mobile),
    score:           moduleScore,
    issues,
  };
}
