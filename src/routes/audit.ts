import type { Env, ModuleResult } from '../lib/types';
import { createSseStream } from '../lib/sse';
import { getCachedAudit, setCachedAudit } from '../lib/cache';
import { fetchWithTimeout } from '../lib/http';
import { detectBotChallenge } from '../lib/bot-detection';
import { upsertBusiness } from '../modules/resolver';
import { runTechnicalSeo } from '../modules/technical_seo';
import { runSchemaAudit } from '../modules/schema_audit';
import { runAuthority } from '../modules/authority';
import { runGeoPredicted, detectVertical, detectLocation } from '../modules/geo_predicted';
import { runContentQuality } from '../modules/content_quality';
import { runRecommendations } from '../modules/recommendations';
import { runKeywords } from '../modules/keywords';
import { runOnPageSeo } from '../modules/on_page_seo';
import { runOffPageSeo } from '../modules/off_page_seo';
import { runSiteIntel } from '../modules/site_intel';
import { runRedirectChain } from '../modules/redirect_chain';
import { runAccessibility } from '../modules/accessibility';
import { runSecurityAudit } from '../modules/security_audit';
import { runSslCert } from '../modules/ssl_cert';
import { runDomainIntel } from '../modules/domain_intel';
import { runCrux } from '../modules/crux';
import { runAiContentInsights } from '../modules/ai_content_insights';
import { runRobotsSitemap } from '../modules/robots_sitemap';
import { runBrokenLinks } from '../modules/broken_links';
import { runMobileAudit } from '../modules/mobile_audit';
import { runLighthouse } from '../modules/lighthouse';

import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/** Normalise raw domain input — strip protocol, path, port, query, leading dots */
export function normaliseDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/[/?#].*$/, '');      // strip path / query / fragment
  d = d.replace(/:\d+$/, '');         // strip port
  d = d.replace(/^\.+|\.+$/g, '');    // strip leading/trailing dots
  return d;
}

async function runModule(
  name: string,
  fn: () => Promise<unknown>,
  timeoutMs: number
): Promise<ModuleResult> {
  const start = Date.now();
  try {
    const data = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return { status: 'ok', data, duration_ms: Date.now() - start };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message, duration_ms: Date.now() - start };
  }
}

// Common inner-page paths to probe for schema and contact enrichment.
// Tried in parallel; first 2 with real content (>500 chars, not bot-challenged) are kept.
// Reduced from 8 → 4 to save subrequests (all 8 were attempted even when 2 succeeded).
const INNER_PAGE_PATHS = [
  '/about', '/contact', '/services', '/faq',
];

async function fetchInnerPages(domain: string): Promise<string[]> {
  const results = await Promise.allSettled(
    INNER_PAGE_PATHS.map(async (path) => {
      const url = `https://${domain}${path}`;
      try {
        const res = await fetchWithTimeout(url, { timeoutMs: 6000 });
        if (!res.ok) return '';
        const html = await res.text();
        return detectBotChallenge(html, url, res.status).isChallenge ? '' : html;
      } catch { return ''; }
    })
  );
  return results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .filter(h => h.length > 500)
    .slice(0, 2);
}

/** Build a short text fingerprint of a page for embedding / similarity lookup */
function buildPageFingerprint(html: string, domain: string): string {
  const title = (html.match(/<title[^>]*>([^<]{0,150})<\/title>/i) ?? [])[1] ?? '';
  const desc  = (html.match(/name=["']description["'][^>]*content=["']([^"']{0,200})["']/i) ?? [])[1] ?? '';
  const body  = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return `${domain} ${title} ${desc} ${body}`.trim();
}

export function handleAudit(domain: string, env: Env): Response {
  const cleanDomain = normaliseDomain(domain);

  return createSseStream(async (emit) => {
    emit('progress', { module: 'cache', status: 'checking' });
    const cached = await getCachedAudit(env, cleanDomain);
    if (cached) {
      const parsed = JSON.parse(cached);
      emit('section', { module: 'cache_hit', status: 'ok', data: parsed });
      emit('complete', parsed);
      return;
    }

    const business = { name: cleanDomain, domain: cleanDomain };
    const businessId = await upsertBusiness(business, env);
    const auditId = ulid();

    await env.DB.prepare(
      `INSERT INTO audits (id, business_id, status) VALUES (?, ?, 'running')`
    ).bind(auditId, businessId).run();

    const modules: Record<string, ModuleResult> = {};

    // ── Pre-fetch shared page once — passed to all modules that need HTML ──
    // CF Workers counts each redirect hop as a subrequest, so we capture the final
    // resolved URL here and pass it to technical_seo to avoid re-following redirects.
    // Inner pages probe starts concurrently so it completes during homepage fetch time.
    const pageStart = Date.now();
    let sharedHtml = '';
    let sharedHeaders: Headers = new Headers();
    let sharedFinalUrl = `https://${cleanDomain}`;
    let sharedStatusCode = 200;
    const innerPagesFetchPromise = fetchInnerPages(cleanDomain);

    /**
     * Detect cross-domain redirect: e.g. tradeverdict.io → buy.stripe.com.
     * Some sites redirect non-browser fetches (or geo-located edge IPs) to payment
     * processors or third-party hosts. Auditing that foreign page produces entirely
     * wrong results. We discard the HTML and reset to empty so modules degrade
     * gracefully — the same path as a bot-blocked or unreachable site.
     * www. prefix is ignored; subdomains of the requested domain are allowed.
     */
    function isForeignRedirect(resolvedUrl: string): boolean {
      try {
        const finalHost = new URL(resolvedUrl).hostname.toLowerCase().replace(/^www\./, '');
        const clean = cleanDomain.toLowerCase().replace(/^www\./, '');
        // Allow: exact match, subdomain of clean (app.example.com), or clean is subdomain
        return finalHost !== clean && !finalHost.endsWith('.' + clean) && !clean.endsWith('.' + finalHost);
      } catch { return false; }
    }

    try {
      const pageRes = await fetchWithTimeout(`https://${cleanDomain}`, { timeoutMs: 12000 });
      sharedHeaders = pageRes.headers;
      sharedStatusCode = pageRes.status;
      // pageRes.url is the final URL after following all redirects (CF Workers behaviour)
      if (pageRes.url) sharedFinalUrl = pageRes.url;
      // Discard HTML if the redirect landed on a completely different domain
      if (!isForeignRedirect(sharedFinalUrl)) {
        sharedHtml = await pageRes.text();
      }
    } catch {
      // HTTPS unreachable — try plain HTTP as fallback for HTTP-only sites (no SSL).
      // Only costs 1 extra subrequest and only fires on HTTPS failure (rare for modern sites).
      // Sets sharedFinalUrl to http:// so technical_seo's HTTPS check correctly fails.
      try {
        const httpRes = await fetchWithTimeout(`http://${cleanDomain}`, { timeoutMs: 10000 });
        const httpFinalUrl = httpRes.url || `http://${cleanDomain}`;
        sharedHeaders = httpRes.headers;
        sharedStatusCode = httpRes.status;
        sharedFinalUrl = httpFinalUrl;
        if (!isForeignRedirect(httpFinalUrl)) {
          sharedHtml = await httpRes.text();
        }
      } catch { /* both protocols failed — modules degrade gracefully with empty strings */ }
    }
    const sharedResponseMs = Date.now() - pageStart;

    // ── Bot-challenge / WAF interstitial detection ────────────────────────────
    // Some sites detect automated fetches and serve a CAPTCHA or WAF challenge
    // page instead of real content.  Running analysis on a challenge page produces
    // entirely false findings: noindex flagged as critical, zero schema, thin
    // content, missing H1/H2, no contact info — all false positives that erode
    // user trust in the tool.
    //
    // Strategy:
    //   • detectBotChallenge() uses 4 layers: HTTP 403 → URL path → title → body.
    //   • When a challenge is detected we set contentHtml = '' so that every
    //     content-analysis module receives an empty string and returns its
    //     graceful empty-state instead of fabricated findings.
    //   • security_audit is the only module that still receives sharedHtml because
    //     its checks are header-based; the raw HTML is only used for `html.length > 0`
    //     (HTTPS-available check) which remains valid even for challenge pages.
    //   • geo_predicted and keywords also receive sharedHtml — they run their own
    //     bot-challenge fallback internally (domain-only inference), which is the
    //     correct behaviour (we still want keyword/GEO output, just domain-derived).
    const botChallenge = detectBotChallenge(sharedHtml, sharedFinalUrl, sharedStatusCode);
    const sharedHtmlIsBotChallenge = botChallenge.isChallenge;

    // contentHtml: blank when bot-blocked so NO content module analyses challenge-page data.
    const contentHtml = sharedHtmlIsBotChallenge ? '' : sharedHtml;

    // ── Start robots_sitemap early — before the parallel module flood ─────────
    // This gives it priority access to the site's robots.txt and sitemap.xml before
    // broken_links starts batching 25 requests and potentially triggering rate-limits.
    const earlyRobotsSitemapPromise = runModule(
      'robots_sitemap',
      () => runRobotsSitemap(cleanDomain, sharedHtmlIsBotChallenge, contentHtml),
      20000,
    );

    // Await inner pages (been running in background since before homepage fetch).
    // Discard if homepage was bot-blocked — inner pages from the same site will be too.
    const innerPagesHtml = sharedHtmlIsBotChallenge ? [] : await innerPagesFetchPromise;

    if (sharedHtmlIsBotChallenge) {
      const botBlockedData = {
        reason: botChallenge.reason ?? 'Bot-challenge page detected',
        note: 'This site uses bot protection (WAF / CAPTCHA) that blocked automated ' +
              'page analysis. Module scores reflect domain-level signals only — ' +
              'page content, meta tags, headings, schema and contact info could ' +
              'not be read. Visit the site directly in a browser for full results.',
      };
      // Store in modules so recommendations can detect and suppress content-dependent recs
      modules.bot_blocked = { status: 'partial', data: botBlockedData };
      emit('section', { module: 'bot_blocked', status: 'partial', data: botBlockedData });
    }

    // ── Look up any user-submitted override for this domain (Layer 1) ──────
    let verticalOverride: string | null = null;
    let locationOverride: string | null = null;
    try {
      const override = await env.DB.prepare(
        `SELECT vertical, location FROM domain_overrides WHERE domain = ?`
      ).bind(cleanDomain).first<{ vertical: string | null; location: string | null }>();
      if (override) {
        verticalOverride = override.vertical;
        locationOverride = override.location;
      }
    } catch { /* non-critical */ }

    // ── Layer 3: regex detection first (zero subrequests) ────────────────────
    // Run before Vectorize so we can skip the 2-subrequest embed+query for the
    // majority of sites where the regex already returns a specific vertical.
    // Location is only propagated for local-service verticals — global SaaS/tech sites
    // mention cities in blog posts and testimonials, producing false-positive locations.
    // Skip entirely if sharedHtml is a bot-challenge page — content is useless.
    const LOCAL_SERVICE_VERTICALS = new Set(['dental','legal','fitness','real_estate','hotel','restaurant','food_delivery','medical']);
    if (!verticalOverride && sharedHtml && !sharedHtmlIsBotChallenge) {
      try {
        const titleText = (sharedHtml.match(/<title[^>]*>([^<]{0,200})<\/title>/i) ?? [])[1] ?? '';
        const descText  = (sharedHtml.match(/name=["']description["'][^>]*content=["']([^"']{0,300})["']/i) ?? [])[1] ?? '';
        const bodySnip  = sharedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
        const fingerprint = `${titleText} ${descText} ${bodySnip}`.trim();
        const detected = detectVertical(fingerprint);
        // Only set if not generic — keeps Vectorize + AI fallback for ambiguous pages
        if (detected !== 'general') verticalOverride = detected;
        // Only detect location for local-service verticals — not for tech/ecommerce/finance/etc.
        // which mention cities in content but have no meaningful single location.
        if (!locationOverride && LOCAL_SERVICE_VERTICALS.has(detected)) {
          const detectedLoc = detectLocation(fingerprint);
          if (detectedLoc !== 'your area') locationOverride = detectedLoc;
        }
      } catch { /* non-critical */ }
    }

    // ── Layer 2: Vectorize similarity — only if regex returned 'general' ──────
    // Skipping saves 2 subrequests (embed + vector query) for most sites.
    // Vectorize is most useful for niche/ambiguous pages the regex can't classify.
    // Skip when sharedHtml is a bot-challenge page — embedding garbage wastes subrequests.
    if (!verticalOverride && sharedHtml && !sharedHtmlIsBotChallenge) {
      try {
        const fingerprint = buildPageFingerprint(sharedHtml, cleanDomain);
        const emb = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
          text: fingerprint,
        } as Parameters<typeof env.AI.run>[1]) as { data: number[][] };
        if (emb?.data?.[0]) {
          const nearest = await (env.VECTORS as any).query(emb.data[0], { topK: 1, returnMetadata: 'all' });
          const top = nearest?.matches?.[0];
          if (top && top.score > 0.93 && top.metadata?.vertical) {
            verticalOverride = top.metadata.vertical as string;
          }
        }
      } catch { /* Vectorize is best-effort */ }
    }

    // ── All modules in parallel — stream each result as it lands ──────────
    // NOTE: Lighthouse is NOT in this list — it runs via /api/lighthouse (own Worker
    // invocation) to avoid hitting the 50 subrequest/invocation limit on free plan.
    const PROGRESS_MODULES = [
      'technical_seo','schema_audit','content_quality','authority','geo_predicted',
      'keywords','on_page_seo','off_page_seo','site_intel',
      'redirect_chain','accessibility','security_audit','ssl_cert',
      'domain_intel','crux','robots_sitemap','broken_links','mobile_audit',
    ];
    PROGRESS_MODULES.forEach(m => emit('progress', { module: m, status: 'running' }));

    await Promise.all([
      runModule('technical_seo', () => runTechnicalSeo(cleanDomain, contentHtml, sharedHeaders, sharedResponseMs, sharedFinalUrl), 22000).then(r => {
        modules.technical_seo = r;
        emit('section', { module: 'technical_seo', ...r });
      }),
      runModule('schema_audit', () => runSchemaAudit(cleanDomain, contentHtml, innerPagesHtml), 15000).then(r => {
        modules.schema_audit = r;
        emit('section', { module: 'schema_audit', ...r });
      }),
      runModule('content_quality', () => runContentQuality(cleanDomain, contentHtml, innerPagesHtml), 15000).then(r => {
        modules.content_quality = r;
        emit('section', { module: 'content_quality', ...r });
      }),
      runModule('authority', () => runAuthority(cleanDomain, business.name, env.OPENPAGERANK_KEY), 25000).then(r => {
        modules.authority = r;
        emit('section', { module: 'authority', ...r });
      }),
      runModule('geo_predicted', () => runGeoPredicted(cleanDomain, env, sharedHtml, verticalOverride, locationOverride), 25000).then(r => {
        modules.geo_predicted = r;
        // Suppress when AI was unavailable and results are generic templates
        const geoData = r.data as { is_reliable?: boolean } | null;
        if (r.status === 'ok' && geoData?.is_reliable === false) {
          emit('section', { module: 'geo_predicted', status: 'skipped', data: r.data });
        } else {
          emit('section', { module: 'geo_predicted', ...r });
        }
      }),
      runModule('keywords', () => runKeywords(cleanDomain, env, sharedHtml, verticalOverride, locationOverride), 20000).then(r => {
        modules.keywords = r;
        // Suppress when AI was unavailable and seeds are bigram-extracted guesses
        const kwData = r.data as { is_reliable?: boolean } | null;
        if (r.status === 'ok' && kwData?.is_reliable === false) {
          emit('section', { module: 'keywords', status: 'skipped', data: r.data });
        } else {
          emit('section', { module: 'keywords', ...r });
        }
      }),
      runModule('on_page_seo', () => runOnPageSeo(cleanDomain, contentHtml), 30000).then(r => {
        modules.on_page_seo = r;
        emit('section', { module: 'on_page_seo', ...r });
      }),
      runModule('off_page_seo', () => runOffPageSeo(cleanDomain, contentHtml), 20000).then(r => {
        modules.off_page_seo = r;
        emit('section', { module: 'off_page_seo', ...r });
      }),
      runModule('site_intel', () => runSiteIntel(cleanDomain, contentHtml), 25000).then(r => {
        modules.site_intel = r;
        emit('section', { module: 'site_intel', ...r });
      }),
      runModule('redirect_chain', () => runRedirectChain(cleanDomain), 15000).then(r => {
        modules.redirect_chain = r;
        emit('section', { module: 'redirect_chain', ...r });
      }),
      runModule('accessibility', () => runAccessibility(cleanDomain, contentHtml), 30000).then(r => {
        modules.accessibility = r;
        emit('section', { module: 'accessibility', ...r });
      }),
      runModule('security_audit', () => runSecurityAudit(cleanDomain, sharedHtml, sharedHeaders), 28000).then(r => {
        modules.security_audit = r;
        emit('section', { module: 'security_audit', ...r });
      }),
      runModule('ssl_cert', () => runSslCert(cleanDomain), 25000).then(r => {
        modules.ssl_cert = r;
        emit('section', { module: 'ssl_cert', ...r });
      }),
      runModule('domain_intel', () => runDomainIntel(cleanDomain), 20000).then(r => {
        modules.domain_intel = r;
        emit('section', { module: 'domain_intel', ...r });
      }),
      runModule('crux', () => runCrux(cleanDomain, env), 15000).then(r => {
        modules.crux = r;
        emit('section', { module: 'crux', ...r });
      }),
      earlyRobotsSitemapPromise.then(r => {
        modules.robots_sitemap = r;
        emit('section', { module: 'robots_sitemap', ...r });
      }),
      runModule('broken_links', () => runBrokenLinks(cleanDomain, contentHtml), 30000).then(r => {
        modules.broken_links = r;
        emit('section', { module: 'broken_links', ...r });
      }),
      runModule('mobile_audit', () => Promise.resolve(runMobileAudit(cleanDomain, contentHtml)), 5000).then(r => {
        modules.mobile_audit = r;
        emit('section', { module: 'mobile_audit', ...r });
      }),
      // Lighthouse intentionally omitted — runs via /api/lighthouse (separate invocation)
      // to stay within Cloudflare's 50-subrequest-per-invocation free-plan limit.
    ]);

    // ── AI Content Insights (after parallel block — reuses technical_seo data to stay under subrequest limit) ──
    emit('progress', { module: 'ai_content_insights', status: 'running' });
    const techData = (modules.technical_seo?.data ?? {}) as {
      page_meta?: { title?: string | null; description?: string | null };
      top_keywords?: Array<{ word: string; count: number }>;
      h1_tags?: string[];
      h2_tags?: string[];
    };
    const aiPageText = [
      techData.page_meta?.title     ? `Title: ${techData.page_meta.title}` : '',
      techData.page_meta?.description ? `Description: ${techData.page_meta.description}` : '',
      techData.h1_tags?.length     ? `H1: ${techData.h1_tags.join(' | ')}` : '',
      techData.h2_tags?.length     ? `H2 headings: ${techData.h2_tags.slice(0, 8).join(' | ')}` : '',
      techData.top_keywords?.length ? `Top keywords: ${techData.top_keywords.slice(0, 30).map(k => k.word).join(', ')}` : '',
      `Domain: ${cleanDomain}`,
    ].filter(Boolean).join('\n');
    modules.ai_content_insights = await runModule(
      'ai_content_insights',
      () => runAiContentInsights(cleanDomain, env, aiPageText),
      30000,
    );
    // Suppress when AI was unavailable — null data means no useful output
    if (modules.ai_content_insights.status === 'ok' && modules.ai_content_insights.data === null) {
      emit('section', { module: 'ai_content_insights', status: 'skipped', data: null });
    } else {
      emit('section', { module: 'ai_content_insights', ...modules.ai_content_insights });
    }

    // ── Scoring ───────────────────────────────────────────────────────────
    const scores = computeScores(modules);

    // ── Recommendations ───────────────────────────────────────────────────
    emit('progress', { module: 'recommendations', status: 'running' });
    modules.recommendations = await runModule(
      'recommendations',
      () => Promise.resolve(runRecommendations(modules)),
      5000
    );
    emit('section', { module: 'recommendations', ...modules.recommendations });

    const fullAudit = {
      audit_id: auditId,
      business_id: businessId,
      domain: cleanDomain,
      ...scores,
      modules,
      created_at: Date.now(),
    };

    await env.DB.prepare(
      `UPDATE audits SET status='complete', foundation_score=?, weakness_score=?,
       summary_json=?, full_json=?, completed_at=unixepoch() WHERE id=?`
    ).bind(scores.seo_score, scores.geo_score, '', JSON.stringify(fullAudit), auditId).run();

    // 6-hour TTL lets users fix issues and re-audit the same day without seeing stale results.
    // Fall back to 2 hours when AI was unavailable so quota-refresh is caught sooner.
    const geoData = modules.geo_predicted?.data as { is_reliable?: boolean } | null | undefined;
    const cacheTtl = geoData?.is_reliable === false ? 60 * 60 * 2 : 60 * 60 * 6;
    await setCachedAudit(env, cleanDomain, auditId, cacheTtl);
    emit('complete', fullAudit);
  });
}

// ── Normalised 0-100 scoring ──────────────────────────────────────────────

interface Scores {
  seo_score: number;
  geo_score: number;
  overall_score: number;
  aeo_score: number;
  // keep legacy fields so existing D1 schema works
  foundation_score: number;
  weakness_score: number;
}

// Non-linear generous scale applied to all summary scores.
// Lifts mid-range scores without changing 0 or 100:
//   raw  20 → 33   40 → 55   50 → 64   60 → 73   70 → 81   80 → 89
function generous(raw: number): number {
  if (raw <= 0) return 0;
  if (raw >= 100) return 100;
  return Math.round(Math.pow(raw / 100, 0.65) * 100);
}

function computeScores(modules: Record<string, ModuleResult>): Scores {
  const tech = modules.technical_seo?.data as { score?: number } | undefined;
  const schema = modules.schema_audit?.data as { score?: number } | undefined;
  const content = modules.content_quality?.data as { score?: number; word_count?: number } | undefined;
  const auth = modules.authority?.data as {
    domain_age_years?: number; wikipedia?: boolean; wikidata_id?: string; indexed_page_count?: number | null;
  } | undefined;
  const geo = modules.geo_predicted?.data as { citation_rate?: number; is_reliable?: boolean } | undefined;

  const techScore = tech?.score ?? 0;
  let schemaScore = schema?.score ?? 0;
  let contentScore = content?.score ?? 0;

  // SPA/large-platform correction: JS-rendered sites return near-zero word counts via
  // server-side fetch, falsely triggering "thin content" and "no schema" penalties.
  const isSpa = (content?.word_count ?? 999) < 50;
  const isEstablishedPlatform =
    (auth?.wikipedia || !!auth?.wikidata_id) && (auth?.domain_age_years ?? 0) >= 5;
  if (isSpa && isEstablishedPlatform) {
    contentScore = Math.max(contentScore, 55);
    schemaScore  = Math.max(schemaScore,  40);
  }

  // Raw SEO (0-100) = tech 40% + schema 30% + content 30%
  const rawSeo = Math.round(techScore * 0.4 + schemaScore * 0.3 + contentScore * 0.3);

  // Raw GEO (0-100) = authority 70% + citation 30%
  // Citation rate is an AI prediction that's often unreliable (0 for JS SPAs, new sites, etc.)
  // Authority (Wikipedia, Wikidata, domain age) is objectively verifiable — weight it higher.
  let authorityRaw = 0;
  if (auth) {
    if ((auth.domain_age_years ?? 0) >= 10) authorityRaw += 35;
    else if ((auth.domain_age_years ?? 0) >= 5) authorityRaw += 25;
    else if ((auth.domain_age_years ?? 0) >= 2) authorityRaw += 12;
    if (auth.wikipedia) authorityRaw += 30;
    if (auth.wikidata_id) authorityRaw += 20;
    if ((auth.indexed_page_count ?? 0) >= 50) authorityRaw += 15;
    else if ((auth.indexed_page_count ?? 0) >= 10) authorityRaw += 8;
    else if (isEstablishedPlatform) authorityRaw += 8;
  }
  // Only use citation rate when AI actually ran — heuristic fallback always returns 0 and is not meaningful.
  // When unavailable, fall back to authority-only scoring rather than penalising for missing data.
  const citationAvailable = geo?.is_reliable !== false && geo?.citation_rate !== undefined;
  const citationScore = citationAvailable ? Math.round((geo!.citation_rate ?? 0) * 100) : null;
  const rawGeo = citationScore !== null
    ? Math.round(Math.min(100, authorityRaw) * 0.7 + citationScore * 0.3)
    : Math.min(100, authorityRaw);

  // Overall raw = SEO 55% + GEO 45%
  const rawOverall = Math.round(rawSeo * 0.55 + rawGeo * 0.45);

  // Apply generous non-linear scale to all three summary scores
  const seo_score     = generous(rawSeo);
  const geo_score     = generous(rawGeo);
  const overall_score = generous(rawOverall);

  // AEO Score — rule-based, 0-100, no API calls
  const aeo_score = computeAeoScore(modules);

  // Legacy compat
  const foundation_score = Math.round(overall_score / 100 * 14);
  const weakness_score = Math.round((100 - overall_score) / 100 * 16);

  return { seo_score, geo_score, overall_score, aeo_score, foundation_score, weakness_score };
}

// ── AEO Score — Answer Engine Optimisation (0-100, rule-based) ────────────────
// Signals that make content more likely to be cited/surfaced by AI answer engines
// (ChatGPT, Perplexity, Google AI Overviews, Claude, etc.)
function computeAeoScore(modules: Record<string, ModuleResult>): number {
  const schema    = modules.schema_audit?.data   as Record<string, any> | undefined;
  const tech      = modules.technical_seo?.data  as Record<string, any> | undefined;
  const content   = modules.content_quality?.data as Record<string, any> | undefined;
  const authority = modules.authority?.data       as Record<string, any> | undefined;

  let pts = 0;

  // ── Off-site entity authority ──────────────────────────────────────────────
  // Wikipedia/Wikidata = the brand is a known entity in LLM training data.
  // Open PageRank = how widely cited the domain is across the web, which
  // correlates directly with AI training-data inclusion and citation likelihood.
  // Without these, large well-known brands would score unfairly low purely
  // because their homepage lacks FAQ schema.
  if (authority?.wikipedia)       pts += 18; // Wikipedia page = major entity signal
  if (authority?.wikidata_id)     pts += 8;  // Wikidata entry = structured knowledge graph presence
  const pageRank: number = authority?.page_rank ?? 0;
  if (pageRank >= 7)              pts += 14;
  else if (pageRank >= 5)         pts += 10;
  else if (pageRank >= 3)         pts += 6;
  else if (pageRank >= 1)         pts += 3;

  // ── Schema signals ─────────────────────────────────────────────────────────
  const schemaTypes = new Set<string>(schema?.schemas_found ?? []);
  if (schemaTypes.has('FAQPage'))                                          pts += 20; // highest AEO signal
  if (schemaTypes.has('QAPage'))                                           pts += 15;
  if (schemaTypes.has('HowTo'))                                            pts += 14;
  if (schemaTypes.has('Speakable'))                                        pts += 10;
  if (schemaTypes.has('Article') || schemaTypes.has('BlogPosting') ||
      schemaTypes.has('NewsArticle') || schemaTypes.has('TechArticle'))   pts += 8;
  if (schemaTypes.has('BreadcrumbList'))                                   pts += 5;  // navigation clarity

  // ── Question-format headings ───────────────────────────────────────────────
  // AI engines extract Q&A pairs from H2/H3 that contain question marks
  const h2Tags: string[] = tech?.h2_tags ?? [];
  const questionHeadings = h2Tags.filter((h: string) => h.trim().endsWith('?')).length;
  if (questionHeadings >= 5)       pts += 15;
  else if (questionHeadings >= 3)  pts += 10;
  else if (questionHeadings >= 1)  pts += 5;

  // ── Meta description ───────────────────────────────────────────────────────
  // A concise, factual description (50-160 chars) is often used verbatim by AI
  const metaDesc: string = tech?.page_meta?.description ?? '';
  if (metaDesc.length >= 50 && metaDesc.length <= 160) pts += 8;

  // ── Content depth ──────────────────────────────────────────────────────────
  const wordCount: number = content?.word_count ?? 0;
  if (wordCount >= 1500)       pts += 10;
  else if (wordCount >= 800)   pts += 7;
  else if (wordCount >= 400)   pts += 3;

  // ── Content quality ────────────────────────────────────────────────────────
  const contentScore: number = content?.score ?? 0;
  if (contentScore >= 75) pts += 5;

  // ── Schema richness (multiple structured types = well-organised content) ───
  if ((schema?.schemas_found?.length ?? 0) >= 4) pts += 5;

  return Math.min(100, pts);
}
