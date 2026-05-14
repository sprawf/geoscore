import type { Env } from './types';

export async function getCachedAudit(env: Env, domain: string): Promise<string | null> {
  const auditId = await env.AUDIT_KV.get(`recent:${domain}`);
  if (!auditId) return null;
  const row = await env.DB.prepare(
    'SELECT full_json FROM audits WHERE id = ? AND status = ?'
  ).bind(auditId, 'complete').first<{ full_json: string }>();
  return row?.full_json ?? null;
}

export async function setCachedAudit(env: Env, domain: string, auditId: string): Promise<void> {
  await env.AUDIT_KV.put(`recent:${domain}`, auditId, { expirationTtl: 60 * 60 * 24 * 7 });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
