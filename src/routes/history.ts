import type { Env } from '../lib/types';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface AuditRow {
  id: string;
  foundation_score: number | null; // stores seo_score
  weakness_score: number | null;   // stores geo_score
  created_at: number;
  completed_at: number | null;
}

export async function handleHistory(domain: string, env: Env): Promise<Response> {
  try {
    const biz = await env.DB.prepare(
      'SELECT id FROM businesses WHERE domain = ? LIMIT 1'
    ).bind(domain).first<{ id: number }>();

    if (!biz) {
      return new Response(JSON.stringify({ history: [] }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    const rows = await env.DB.prepare(
      `SELECT id, foundation_score, weakness_score, created_at, completed_at
       FROM audits
       WHERE business_id = ? AND status = 'complete'
       ORDER BY created_at DESC
       LIMIT 20`
    ).bind(biz.id).all<AuditRow>();

    const history = (rows.results ?? [])
      .map(row => {
        const seo = row.foundation_score ?? 0;
        const geo = row.weakness_score ?? 0;
        return {
          audit_id: row.id,
          date: (row.completed_at ?? row.created_at) * 1000,
          seo_score: seo,
          geo_score: geo,
          overall_score: Math.round(seo * 0.55 + geo * 0.45),
        };
      })
      .reverse(); // oldest first for sparkline

    return new Response(JSON.stringify({ history }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch {
    return new Response(JSON.stringify({ history: [] }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
}
