import type { Env } from './types';

// 50 full audits per IP per hour during active development; 120 searches per IP per minute
const AUDIT_LIMIT = 50;
const SEARCH_LIMIT = 120;

function hourKey(ip: string) {
  return `rl:audit:${ip}:${new Date().toISOString().slice(0, 13)}`;
}
function minuteKey(ip: string) {
  return `rl:search:${ip}:${new Date().toISOString().slice(0, 16)}`;
}

export async function auditRateLimit(
  env: Env,
  ip: string
): Promise<{ limited: boolean; retryAfter: number }> {
  const key = hourKey(ip);
  const count = parseInt((await env.BUDGET_KV.get(key)) ?? '0', 10);
  if (count >= AUDIT_LIMIT) return { limited: true, retryAfter: 3600 };
  await env.BUDGET_KV.put(key, String(count + 1), { expirationTtl: 7200 });
  return { limited: false, retryAfter: 0 };
}

export async function searchRateLimit(
  env: Env,
  ip: string
): Promise<{ limited: boolean }> {
  const key = minuteKey(ip);
  const count = parseInt((await env.BUDGET_KV.get(key)) ?? '0', 10);
  if (count >= SEARCH_LIMIT) return { limited: true };
  await env.BUDGET_KV.put(key, String(count + 1), { expirationTtl: 120 });
  return { limited: false };
}

export function getClientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ??
    req.headers.get('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown'
  );
}
