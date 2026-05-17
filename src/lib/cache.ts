import type { Env } from './types';

/**
 * Increment CACHE_VERSION whenever vertical-detection logic changes.
 * This automatically invalidates all cached audits on the next deploy —
 * every cached key becomes a different string so old entries are ignored
 * and expire naturally (KV TTL) without needing a manual flush.
 */
const CACHE_VERSION = 'v8';

export function cacheKey(domain: string): string {
  return `recent:${CACHE_VERSION}:${domain}`;
}

export async function getCachedAudit(env: Env, domain: string): Promise<string | null> {
  const auditId = await env.AUDIT_KV.get(cacheKey(domain));
  if (!auditId) return null;
  const row = await env.DB.prepare(
    'SELECT full_json FROM audits WHERE id = ? AND status = ?'
  ).bind(auditId, 'complete').first<{ full_json: string }>();
  return row?.full_json ?? null;
}

export async function setCachedAudit(
  env: Env,
  domain: string,
  auditId: string,
  ttlSeconds = 60 * 60 * 24 * 3, // 3 days — reduced from 7 to limit stale-vertical window
): Promise<void> {
  await env.AUDIT_KV.put(cacheKey(domain), auditId, { expirationTtl: ttlSeconds });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
