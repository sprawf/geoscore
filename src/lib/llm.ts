import type { Env } from './types';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Stable short hash for a string — used as KV cache key.
 * FNV-1a 32-bit, hex-encoded. Fast, no crypto API needed.
 */
function fnv32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Unified LLM call with automatic fallback + KV response cache.
 *
 * Priority:
 *  1. KV cache (24-hour TTL) — costs zero quota, instant response
 *  2. Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct) — free tier
 *  3. Groq (llama-3.1-8b-instant) — free: 14,400 req/day
 *
 * Falls back to Groq on ANY CF AI error (not just quota 4006).
 * This ensures quota exhaustion, capacity issues, or transient errors
 * never silently kill AI modules when Groq is still available.
 *
 * Successful responses are cached in AUDIT_KV for 24 h so repeated audits
 * of the same domain don't burn API quota.
 */
export async function callLlm(
  messages: LlmMessage[],
  max_tokens: number,
  env: Env,
): Promise<string> {
  // ── 0. KV cache check ───────────────────────────────────────────────────────
  // Key: "llm:" + fnv32(serialised messages + max_tokens)
  // 24-hour TTL — safe for keyword/geo insights which are domain-stable
  const cacheKey = `llm:${fnv32(JSON.stringify(messages) + max_tokens)}`;
  try {
    const cached = await env.AUDIT_KV.get(cacheKey);
    if (cached) return cached;
  } catch { /* non-critical — proceed to live call */ }

  // ── 1. Cloudflare Workers AI ────────────────────────────────────────────────
  let cfText = '';
  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages,
      max_tokens,
    } as Parameters<typeof env.AI.run>[1]);
    cfText = (result as { response?: string }).response ?? '';
  } catch {
    // ANY CF AI error (quota 4006, capacity, timeout) → fall through to Groq.
    // We previously only fell through on 4006, so other errors silently killed
    // AI modules even when Groq had plenty of quota remaining.
    cfText = '';
  }

  if (cfText) {
    // Cache and return CF AI result
    try { await env.AUDIT_KV.put(cacheKey, cfText, { expirationTtl: 86400 }); } catch { /* non-critical */ }
    return cfText;
  }

  // ── 2. Groq fallback (llama-3.1-8b-instant = Llama 3.1 8B, same model) ─────
  if (!env.GROQ_API_KEY) {
    throw new Error('CF AI unavailable — set GROQ_API_KEY secret for free fallback');
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages,
      max_tokens,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const groqText = data.choices?.[0]?.message?.content ?? '';

  // Cache and return Groq result
  if (groqText) {
    try { await env.AUDIT_KV.put(cacheKey, groqText, { expirationTtl: 86400 }); } catch { /* non-critical */ }
  }
  return groqText;
}
