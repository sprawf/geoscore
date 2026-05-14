import type { Env } from './lib/types';
import { fetchWithTimeout } from './lib/http';
import { auditRateLimit, searchRateLimit, getClientIp } from './lib/rate-limit';
import { getCachedAudit } from './lib/cache';
import { handleSearch } from './routes/search';
import { handleAudit, normaliseDomain } from './routes/audit';
import { handleChat } from './routes/chat';
import { handleFix } from './routes/fix';
import { handleBusinesses } from './routes/businesses';
import { handleLlmsGen } from './routes/llms_gen';
import { handleHistory } from './routes/history';
import { handleFeedback, handleLearningAdmin } from './routes/feedback';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const ip = getClientIp(req);

    if (pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(env);
    }


    if (pathname === '/api/stats' && req.method === 'GET') {
      try {
        const row = await env.DB.prepare(`SELECT COUNT(*) as count FROM audits WHERE status='complete'`).first<{count:number}>();
        return new Response(JSON.stringify({ audits: row?.count ?? 0 }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' },
        });
      } catch {
        return new Response(JSON.stringify({ audits: 0 }), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
    }

    if (pathname === '/api/businesses' && req.method === 'GET') {
      return handleBusinesses(env);
    }

    if (pathname === '/api/recent' && req.method === 'GET') {
      try {
        const rows = await env.DB.prepare(
          `SELECT b.domain, a.foundation_score as seo_score, a.weakness_score as geo_score,
                  MAX(COALESCE(a.completed_at, a.created_at)) as ts
           FROM audits a JOIN businesses b ON a.business_id = b.id
           WHERE a.status = 'complete'
           GROUP BY b.domain
           ORDER BY ts DESC LIMIT 10`
        ).all<{ domain: string; seo_score: number; geo_score: number; ts: number }>();
        const recent = (rows.results ?? []).map(r => ({
          domain: r.domain,
          overall_score: Math.round((r.seo_score ?? 0) * 0.55 + (r.geo_score ?? 0) * 0.45),
        }));
        return new Response(JSON.stringify({ recent }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' },
        });
      } catch {
        return new Response(JSON.stringify({ recent: [] }), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const { limited } = await searchRateLimit(env, ip);
      if (limited) return rateLimitedResponse(60);
      return handleSearch(req, env);
    }

    if (pathname.startsWith('/api/audit/') && pathname.endsWith('/cache') && req.method === 'DELETE') {
      const raw = decodeURIComponent(pathname.replace('/api/audit/', '').replace('/cache', ''));
      const domain = normaliseDomain(raw);
      if (!domain || domain.length < 3 || !domain.includes('.')) return jsonError('Invalid domain', 400);
      await env.AUDIT_KV.delete(`recent:${domain}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (pathname.startsWith('/api/audit/') && req.method === 'GET') {
      const raw = decodeURIComponent(pathname.replace('/api/audit/', ''));
      const domain = normaliseDomain(raw);
      if (!domain || domain.length < 3 || !domain.includes('.')) {
        return jsonError('Invalid domain', 400);
      }
      // Cache hits are free — don't consume rate limit quota
      const cached = await getCachedAudit(env, domain);
      if (!cached) {
        const { limited, retryAfter } = await auditRateLimit(env, ip);
        if (limited) return rateLimitedResponse(retryAfter);
      }
      return handleAudit(domain, env);
    }

    if (pathname.startsWith('/api/chat/') && req.method === 'POST') {
      const auditId = pathname.replace('/api/chat/', '').trim();
      if (!auditId || auditId.length < 10) return jsonError('Invalid audit ID', 400);
      return handleChat(req, auditId, env, ctx);
    }

    if (pathname === '/api/fix' && req.method === 'POST') {
      return handleFix(req, env);
    }

    if (pathname === '/api/llms-gen' && req.method === 'POST') {
      return handleLlmsGen(req, env);
    }

    // Proxy llms.txt fetches — direct browser fetch is blocked by CORS on most sites
    if (pathname === '/api/fetch-llms' && req.method === 'GET') {
      const raw = url.searchParams.get('domain') ?? '';
      const domain = normaliseDomain(raw);
      if (!domain || !domain.includes('.')) return jsonError('Invalid domain', 400);
      try {
        const res = await fetch(`https://${domain}/llms.txt`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: `HTTP ${res.status} — no llms.txt at this URL` }), {
            status: res.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        const text = await res.text();
        return new Response(text, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: `Could not reach ${domain}/llms.txt` }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    if (pathname.startsWith('/api/history/') && req.method === 'GET') {
      const raw = decodeURIComponent(pathname.replace('/api/history/', ''));
      const domain = normaliseDomain(raw);
      if (!domain || domain.length < 3) return jsonError('Invalid domain', 400);
      return handleHistory(domain, env);
    }

    // ── Compare endpoint: GET /api/compare?domains=a.com,b.com ──────────────
    if (pathname === '/api/compare' && req.method === 'GET') {
      const raw = url.searchParams.get('domains') ?? '';
      const domains = raw.split(',').map(d => normaliseDomain(d.trim())).filter(d => d.length > 3 && d.includes('.'));
      if (domains.length < 2) return jsonError('Provide at least 2 comma-separated domains', 400);
      const { limited } = await auditRateLimit(env, ip);
      if (limited) return rateLimitedResponse(60);
      return handleCompare(domains, env);
    }

    // ── Monitor endpoint: POST /api/monitor ──────────────────────────────────
    if (pathname === '/api/monitor' && req.method === 'POST') {
      return handleMonitor(req, env);
    }

    // ── Embed widget script: GET /embed.js ───────────────────────────────────
    if (pathname === '/embed.js' && req.method === 'GET') {
      return handleEmbedScript(url);
    }

    // ── Feedback: POST /api/feedback ─────────────────────────────────────────
    if (pathname === '/api/feedback' && req.method === 'POST') {
      return handleFeedback(req, env);
    }

    // ── Learning admin: GET /api/learning ────────────────────────────────────
    if (pathname === '/api/learning' && req.method === 'GET') {
      return handleLearningAdmin(env);
    }

    return jsonError('Not found', 404);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await env.BUDGET_KV.delete(`browser:${yesterday}`);
    await env.BUDGET_KV.delete(`ai:${yesterday}`);

    // Weekly monitoring: re-audit subscribed domains and email if scores changed
    // Also run pattern learning aggregation
    if (event.cron === '0 8 * * 1') { // Mondays at 08:00 UTC
      await Promise.all([
        runMonitoringAlerts(env),
        runWeeklyLearning(env),
      ]);
    }
  },
};

async function handleHealth(env: Env): Promise<Response> {
  const checks: Record<string, string> = {};
  const t = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); checks[name] = 'ok'; }
    catch { checks[name] = 'error'; }
  };
  await Promise.all([
    t('d1', () => env.DB.prepare('SELECT 1').run()),
    t('kv', () => env.AUDIT_KV.get('health-check')),
    t('budget_kv', () => env.BUDGET_KV.get('health-check')),
  ]);
  const allOk = Object.values(checks).every(v => v === 'ok');
  return new Response(JSON.stringify({ status: allOk ? 'ok' : 'degraded', checks, ts: Date.now() }), {
    status: allOk ? 200 : 503,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function rateLimitedResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: 'Rate limit exceeded', retryAfter }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        ...CORS_HEADERS,
      },
    }
  );
}

// ── /api/compare ─────────────────────────────────────────────────────────────
async function handleCompare(domains: string[], env: Env): Promise<Response> {
  const { runTechnicalSeo } = await import('./modules/technical_seo');
  const { runSchemaAudit }  = await import('./modules/schema_audit');
  const { runContentQuality } = await import('./modules/content_quality');
  const { runAuthority }    = await import('./modules/authority');
  const { runGeoPredicted } = await import('./modules/geo_predicted');

  const results: Record<string, object> = {};

  await Promise.all(domains.map(async (domain) => {
    try {
      // Check KV cache first — free lookup
      const cached = await getCachedAudit(env, domain);
      if (cached) {
        const parsed = JSON.parse(cached);
        results[domain] = {
          overall_score: parsed.overall_score ?? 0,
          seo_score:     parsed.seo_score ?? 0,
          geo_score:     parsed.geo_score ?? 0,
        };
        return;
      }

      // Pre-fetch shared page once for this domain
      let sharedHtml = ''; let sharedHeaders: Headers = new Headers(); const t0 = Date.now();
      try { const pr = await fetchWithTimeout(`https://${domain}`, { timeoutMs: 10000 }); sharedHtml = await pr.text(); sharedHeaders = pr.headers; } catch {}
      const sharedMs = Date.now() - t0;

      // Run lightweight subset: tech + schema + content + authority + geo
      const [tech, schema, content, auth, geo] = await Promise.all([
        runTechnicalSeo(domain, sharedHtml, sharedHeaders, sharedMs).catch(() => null),
        runSchemaAudit(domain, sharedHtml).catch(() => null),
        runContentQuality(domain, sharedHtml).catch(() => null),
        runAuthority(domain, domain).catch(() => null),
        runGeoPredicted(domain, env, sharedHtml).catch(() => null),
      ]);

      // Replicate scoring from audit.ts computeScores
      const techScore    = (tech as any)?.score ?? 0;
      const schemaScore  = (schema as any)?.score ?? 0;
      const contentScore = (content as any)?.score ?? 0;
      const rawSeo = Math.round(techScore * 0.4 + schemaScore * 0.3 + contentScore * 0.3);

      let authorityRaw = 0;
      const a = auth as any;
      if (a) {
        if ((a.domain_age_years ?? 0) >= 10) authorityRaw += 35;
        else if ((a.domain_age_years ?? 0) >= 5) authorityRaw += 25;
        else if ((a.domain_age_years ?? 0) >= 2) authorityRaw += 12;
        if (a.wikipedia) authorityRaw += 30;
        if (a.wikidata_id) authorityRaw += 20;
        if ((a.backlink_sample_count ?? 0) >= 200) authorityRaw += 15;
        else if ((a.backlink_sample_count ?? 0) >= 30) authorityRaw += 8;
      }
      const citationScore = Math.round(((geo as any)?.citation_rate ?? 0) * 100);
      const rawGeo = Math.round(Math.min(100, authorityRaw) * 0.7 + citationScore * 0.3);
      const rawOverall = Math.round(rawSeo * 0.55 + rawGeo * 0.45);

      const generous = (raw: number) => raw <= 0 ? 0 : raw >= 100 ? 100 : Math.round(Math.pow(raw / 100, 0.65) * 100);

      results[domain] = {
        overall_score: generous(rawOverall),
        seo_score:     generous(rawSeo),
        geo_score:     generous(rawGeo),
      };
    } catch {
      results[domain] = { overall_score: 0, seo_score: 0, geo_score: 0 };
    }
  }));

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── /api/monitor ─────────────────────────────────────────────────────────────
async function handleMonitor(req: Request, env: Env): Promise<Response> {
  try {
    const { domain, email } = await req.json() as { domain?: string; email?: string };
    if (!domain || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonError('Invalid domain or email', 400);
    }

    // Ensure table exists (idempotent)
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_subs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        email TEXT NOT NULL,
        last_overall INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(domain, email)
      )
    `).run();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO monitor_subs (domain, email) VALUES (?, ?)`
    ).bind(domain.toLowerCase(), email.toLowerCase()).run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch {
    return jsonError('Failed to save subscription', 500);
  }
}

// ── Monitoring cron job ───────────────────────────────────────────────────────
async function runMonitoringAlerts(env: Env): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT domain, email, last_overall FROM monitor_subs ORDER BY domain`
    ).all();

    if (!rows.results?.length) return;

    const { runTechnicalSeo } = await import('./modules/technical_seo');
    const { runSchemaAudit }  = await import('./modules/schema_audit');
    const { runContentQuality } = await import('./modules/content_quality');

    for (const row of rows.results as { domain: string; email: string; last_overall: number }[]) {
      try {
        let sHtml = ''; let sHdrs: Headers = new Headers(); const st0 = Date.now();
        try { const pr = await fetchWithTimeout(`https://${row.domain}`, { timeoutMs: 10000 }); sHtml = await pr.text(); sHdrs = pr.headers; } catch {}
        const sMs = Date.now() - st0;
        const [tech, schema, content] = await Promise.all([
          runTechnicalSeo(row.domain, sHtml, sHdrs, sMs).catch(() => null),
          runSchemaAudit(row.domain, sHtml).catch(() => null),
          runContentQuality(row.domain, sHtml).catch(() => null),
        ]);
        const rawSeo = Math.round(
          ((tech as any)?.score ?? 0) * 0.4 +
          ((schema as any)?.score ?? 0) * 0.3 +
          ((content as any)?.score ?? 0) * 0.3
        );
        const newScore = rawSeo;
        const delta = newScore - row.last_overall;

        if (Math.abs(delta) >= 5 && (env as any).RESEND_API_KEY) {
          await sendAlertEmail(env, row.email, row.domain, row.last_overall, newScore, delta);
        }

        await env.DB.prepare(
          `UPDATE monitor_subs SET last_overall = ? WHERE domain = ? AND email = ?`
        ).bind(newScore, row.domain, row.email).run();
      } catch { /* skip individual failures */ }
    }
  } catch { /* skip if table doesn't exist yet */ }
}

async function sendAlertEmail(env: Env, to: string, domain: string, oldScore: number, newScore: number, delta: number): Promise<void> {
  const direction = delta > 0 ? '📈 improved' : '📉 dropped';
  const auditUrl  = `https://geoscoreapp.pages.dev/?d=${domain}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${(env as any).RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'GeoScore <alerts@geoscoreapp.pages.dev>',
      to: [to],
      subject: `${domain} SEO score ${direction} by ${Math.abs(delta)} points`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto;padding:32px;background:#fff;border-radius:16px;border:1px solid #e2e8f0">
          <h2 style="margin:0 0 8px;font-size:20px;color:#1e293b">SEO Score Alert</h2>
          <p style="margin:0 0 20px;color:#64748b;font-size:14px">Weekly update for <strong>${domain}</strong></p>
          <div style="background:${delta>0?'#dcfce7':'#fee2e2'};border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
            <div style="font-size:36px;font-weight:800;color:${delta>0?'#15803d':'#b91c1c'}">${newScore}</div>
            <div style="font-size:13px;color:${delta>0?'#166534':'#991b1b'};margin-top:4px">${direction} from ${oldScore} (${delta>0?'+':''}${delta} points)</div>
          </div>
          <a href="${auditUrl}" style="display:block;text-align:center;background:#2563eb;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">View Full Audit →</a>
          <p style="margin-top:16px;font-size:11px;color:#94a3b8;text-align:center">You subscribed to weekly alerts for ${domain}. <a href="${auditUrl}" style="color:#94a3b8">Unsubscribe</a></p>
        </div>`,
    }),
  }).catch(() => {});
}

// ── Weekly pattern learning (Layer 3) ────────────────────────────────────────
async function runWeeklyLearning(env: Env): Promise<void> {
  try {
    // Find corrections that happened 2+ times for the same field/value pair in the last 7 days
    const patterns = await env.DB.prepare(`
      SELECT field, reported_value, correct_value,
             COUNT(DISTINCT domain) as domain_count,
             GROUP_CONCAT(domain, ',') as domains
      FROM feedback
      WHERE created_at > unixepoch() - 7 * 86400
        AND correct_value IS NOT NULL
      GROUP BY field, reported_value, correct_value
      HAVING domain_count >= 2
    `).all();

    for (const p of (patterns.results ?? [])) {
      const row = p as {
        field: string;
        reported_value: string;
        correct_value: string;
        domain_count: number;
        domains: string;
      };
      await env.DB.prepare(`
        INSERT INTO learning_patterns (pattern_type, trigger_signal, correction, example_domains, confidence)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).bind(
        `${row.field}_misclassification`,
        row.reported_value,
        row.correct_value,
        row.domains,
        row.domain_count,
      ).run();
    }
  } catch { /* skip if tables don't exist yet */ }
}

// ── /embed.js ─────────────────────────────────────────────────────────────────
function handleEmbedScript(url: URL): Response {
  const domain = url.searchParams.get('domain') ?? '';
  const auditUrl = `https://geoscoreapp.pages.dev/?d=${encodeURIComponent(domain)}`;

  const script = `(function(){
  var d = document.currentScript.getAttribute('data-domain') || ${JSON.stringify(domain)};
  var el = document.createElement('a');
  el.href = 'https://geoscoreapp.pages.dev/?d=' + encodeURIComponent(d);
  el.target = '_blank';
  el.rel = 'noopener';
  el.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:6px 12px;text-decoration:none;font-family:Inter,system-ui,sans-serif;font-size:12px;color:#334155;box-shadow:0 1px 3px rgba(0,0,0,0.08)';
  el.innerHTML = '<svg width="16" height="16" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="6" fill="#2563eb"/><path d="M7 22L13 13L18 18L24 9" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="9" r="2.5" fill="#34d399"/></svg> <span>GeoScore Audit</span>';
  document.currentScript.parentNode.insertBefore(el, document.currentScript.nextSibling);
})();`;

  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS,
    },
  });
}
