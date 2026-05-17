export interface Env {
  DB: D1Database;
  AUDIT_KV: KVNamespace;
  BUDGET_KV: KVNamespace;
  VECTORS: VectorizeIndex;
  AI: Ai;
  NOMINATIM_USER_AGENT: string;
  SEARXNG_URL: string;
  DAILY_BROWSER_BUDGET_SECONDS: string;
  GOOGLE_API_KEY?: string;
  PAGESPEED_API_KEY?: string;
  OPENPAGERANK_KEY?: string;
  GROQ_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
}

export interface Business {
  id?: number;
  name: string;
  domain?: string;
  city?: string;
  country?: string;
  category?: string;
  lat?: number;
  lon?: number;
  osm_id?: string;
  address?: string;
  phone?: string;
}

export interface AuditResult {
  id: string;
  business_id: number;
  status: 'pending' | 'running' | 'complete' | 'failed';
  foundation_score?: number;
  weakness_score?: number;
  modules: Record<string, ModuleResult>;
}

export interface ModuleResult {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  data?: unknown;
  error?: string;
  duration_ms?: number;
}

export interface SseEvent {
  event: 'progress' | 'section' | 'complete' | 'error';
  data: unknown;
}
