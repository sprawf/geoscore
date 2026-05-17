import type { Env } from '../lib/types';
import { callLlm } from '../lib/llm';

export interface AiContentInsightsResult {
  business_context: {
    description: string;
    industry_niche: string;
    target_audience: string;
  };
  content_analysis: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
  };
  trust_scores: {
    topical_relevance: number;
    subject_expertise: number;
    credibility: number;
    summary: string;
  };
  freshness: {
    score: number;
    signals: string[];
    summary: string;
  };
  opportunities: {
    summary: string;
    quick_wins: string[];
  };
  ai_visibility_score: number;
}

const SYSTEM_PROMPT = `You are an expert SEO and content analyst. Analyze the provided webpage content and return a structured JSON object with no extra text. Be concise but specific. Return valid JSON only.

CRITICAL: For the freshness section, report ONLY signals directly observable in the page content (dates in blog posts, copyright year in footer, "last updated" notices, timestamps in testimonials). NEVER infer or guess domain registration dates, founding years, or any date not explicitly written on the page.`;

function buildAnalysisPrompt(domain: string, pageText: string): string {
  return `Analyze this webpage for "${domain}" and return JSON with this exact structure:

{
  "business_context": {
    "description": "1-2 sentence description of what this business does",
    "industry_niche": "specific industry or niche (e.g. 'B2B SaaS payment processing')",
    "target_audience": "primary audience (e.g. 'small business owners and developers')"
  },
  "content_analysis": {
    "summary": "2-3 sentence content quality summary",
    "strengths": ["strength 1", "strength 2", "strength 3"],
    "weaknesses": ["weakness 1", "weakness 2", "weakness 3"]
  },
  "trust_scores": {
    "topical_relevance": 85,
    "subject_expertise": 72,
    "credibility": 68,
    "summary": "1-2 sentence explanation of trust scores"
  },
  "freshness": {
    "score": 60,
    "signals": ["ONLY list signals you can directly observe on the page — e.g. blog post dates, copyright year, 'last updated' notices, dated testimonials. NEVER guess or infer domain registration dates."],
    "summary": "1 sentence about content freshness based only on observable page signals"
  },
  "opportunities": {
    "summary": "1-2 sentences on biggest opportunities",
    "quick_wins": ["action 1", "action 2", "action 3"]
  },
  "ai_visibility_score": 78
}

All numeric scores are 0-100. ai_visibility_score reflects how likely AI assistants (ChatGPT, Gemini, Perplexity) would cite this page.

PAGE CONTENT:
${pageText.slice(0, 3500)}`;
}

async function callAiModel(domain: string, pageText: string, env: Env): Promise<AiContentInsightsResult | null> {
  const text = await callLlm([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildAnalysisPrompt(domain, pageText) },
  ], 1024, env);
  // Extract the largest JSON object from the response (handle preamble/postamble text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const clamp = (n: unknown) => Math.min(100, Math.max(0, Number(n) || 0));

  // Defensive extraction — model may omit or mis-name keys
  const bc = (raw.business_context ?? {}) as Record<string, unknown>;
  const ca = (raw.content_analysis ?? {}) as Record<string, unknown>;
  const ts = (raw.trust_scores ?? {}) as Record<string, unknown>;
  const fr = (raw.freshness ?? {}) as Record<string, unknown>;
  const op = (raw.opportunities ?? {}) as Record<string, unknown>;

  return {
    business_context: {
      description:    String(bc.description    ?? `${domain} — a business website`),
      industry_niche: String(bc.industry_niche ?? 'General'),
      target_audience: String(bc.target_audience ?? 'General audience'),
    },
    content_analysis: {
      summary:    String(ca.summary    ?? ''),
      strengths:  Array.isArray(ca.strengths)  ? ca.strengths.map(String)  : [],
      weaknesses: Array.isArray(ca.weaknesses) ? ca.weaknesses.map(String) : [],
    },
    trust_scores: {
      topical_relevance: clamp(ts.topical_relevance),
      subject_expertise: clamp(ts.subject_expertise),
      credibility:       clamp(ts.credibility),
      summary:           String(ts.summary ?? ''),
    },
    freshness: {
      score:   clamp(fr.score),
      signals: Array.isArray(fr.signals) ? fr.signals.map(String) : [],
      summary: String(fr.summary ?? ''),
    },
    opportunities: {
      summary:    String(op.summary    ?? ''),
      quick_wins: Array.isArray(op.quick_wins) ? op.quick_wins.map(String) : [],
    },
    ai_visibility_score: clamp(raw.ai_visibility_score),
  };
}


export async function runAiContentInsights(
  domain: string,
  env: Env,
  pageText?: string,
): Promise<AiContentInsightsResult | null> {
  // pageText is pre-extracted by audit.ts from technical_seo to avoid a separate fetch
  // (Cloudflare Workers subrequest limit would be exceeded with an extra fetch here)
  if (!pageText) pageText = `Domain: ${domain}`;

  // callLlm handles CF Workers AI → Groq fallback automatically.
  // Returns null when both are unavailable — caller suppresses the module.
  try {
    const result = await callAiModel(domain, pageText, env);
    if (result) return result;
  } catch { /* both CF AI and Groq unavailable — skip module */ }

  return null;
}
