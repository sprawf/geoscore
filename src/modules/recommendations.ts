import type { ModuleResult } from '../lib/types';
import { RECOMMENDATION_TEMPLATES } from '../prompts';

export interface Recommendation {
  template_id: string;
  title: string;
  why: string;
  what_to_do: string;
  impact: number;
  effort: number;
}

interface TechData { llms_txt_present?: boolean; sitemap_url_count?: number; blocked_ai_bots?: string[]; checks?: Array<{ name: string; passed: boolean }>; response_time_ms?: number }
interface SchemaData { coverage?: Record<string, boolean> }
interface AuthData { wikipedia?: boolean; wikidata_id?: string; backlink_sample_count?: number; domain_age_years?: number }
interface GeoData { citation_rate?: number }
interface ContentData { word_count?: number; has_phone?: boolean; h2_count?: number; alt_coverage_pct?: number; has_noindex?: boolean; lang_attr?: string | null; score?: number }

export function runRecommendations(
  modules: Record<string, ModuleResult>
): Recommendation[] {
  const tech = modules.technical_seo?.data as TechData | undefined;
  const schema = modules.schema_audit?.data as SchemaData | undefined;
  const auth = modules.authority?.data as AuthData | undefined;
  const geo = modules.geo_predicted?.data as GeoData | undefined;
  const content = modules.content_quality?.data as ContentData | undefined;

  const recs: Recommendation[] = [];

  // llms.txt — highest GEO impact, lowest effort
  if (!tech?.llms_txt_present) {
    recs.push({
      template_id: 'add_llms_txt',
      title: 'Create /llms.txt so AI engines can index your content',
      why: 'No llms.txt found — AI engines like Perplexity and ChatGPT cannot discover a structured content index for this site.',
      what_to_do: 'Create a plain-text /llms.txt listing your main pages, services, staff, and FAQs. Reference it in robots.txt. Takes under an hour.',
      impact: 5,
      effort: 1,
    });
  }

  // AI bots blocked — critical GEO fix
  if (tech?.blocked_ai_bots && tech.blocked_ai_bots.length > 0) {
    recs.push({
      template_id: 'unblock_ai_crawlers',
      title: `Unblock AI crawlers (${tech.blocked_ai_bots.join(', ')}) in robots.txt`,
      why: `Actively blocking ${tech.blocked_ai_bots.length} AI crawler(s) — this prevents any crawling or citation by LLM-based engines.`,
      what_to_do: 'Remove or narrow the Disallow rules for AI bots in robots.txt. Only block if you have a specific legal reason to prevent AI training.',
      impact: 5,
      effort: 1,
    });
  }

  // Wikidata entity — strong LLM recognition signal
  if (!auth?.wikidata_id) {
    recs.push({
      template_id: 'wikidata_entity',
      title: 'Create a Wikidata entity to establish LLM knowledge graph identity',
      why: 'No Wikidata entity found — LLMs are significantly less likely to cite businesses without a structured knowledge graph entry.',
      what_to_do: 'Create a Wikidata item for this business: official name, location, website URL, founding year, industry. Link it to the official site via schema sameAs.',
      impact: 5,
      effort: 2,
    });
  }

  // LocalBusiness schema — foundational for local SEO
  if (!schema?.coverage?.LocalBusiness) {
    recs.push({
      template_id: 'complete_local_schema',
      title: 'Add LocalBusiness JSON-LD schema with all required fields',
      why: 'No LocalBusiness schema found — AI engines cannot extract structured facts like address, hours, and phone from this site.',
      what_to_do: 'Add LocalBusiness schema in <head> with: name, address, telephone, openingHours, url, geo coordinates, sameAs (Google Maps link). Validate with Schema.org validator.',
      impact: 5,
      effort: 2,
    });
  }

  // GEO citation rate low — content depth issue
  if (geo !== undefined && (geo.citation_rate ?? 0) < 0.4) {
    recs.push({
      template_id: 'expand_service_pages',
      title: 'Add specific facts, prices, and outcomes to service pages',
      why: `${Math.round((geo.citation_rate ?? 0) * 100)}% predicted citation rate — AI engines skip pages with vague marketing copy and no concrete specifics.`,
      what_to_do: 'For each service: add exact price range, procedure duration, number of customers served, named staff member, and measurable outcomes. Be factual, not promotional.',
      impact: 5,
      effort: 3,
    });
  }

  // FAQ schema — AI answer engine optimisation
  if (!schema?.coverage?.FAQPage) {
    recs.push({
      template_id: 'add_faq_schema',
      title: 'Add FAQPage schema to answer common service questions',
      why: 'No FAQPage schema found — AI engines favour pages with structured Q&A when constructing answers to user queries.',
      what_to_do: 'Add a FAQ section to each service page covering the 5 most common questions. Mark up with FAQPage JSON-LD. Include pricing, availability, and process questions.',
      impact: 4,
      effort: 2,
    });
  }

  // Sitemap missing
  if (!tech?.sitemap_url_count || tech.sitemap_url_count === 0) {
    recs.push({
      template_id: 'sitemap_update',
      title: 'Create and submit an XML sitemap',
      why: 'No sitemap.xml found — search engines are crawling without a structured content map, likely missing pages.',
      what_to_do: 'Generate an XML sitemap for all service, location, and blog pages. Submit via Google Search Console. Include lastmod dates.',
      impact: 4,
      effort: 2,
    });
  }

  // Open Graph missing
  if (tech?.checks?.find((c) => c.name === 'Open Graph tags present' && !c.passed)) {
    recs.push({
      template_id: 'og_tags',
      title: 'Add Open Graph tags for social sharing and link previews',
      why: 'No Open Graph tags detected — links shared on social media show no image or description, reducing click-through.',
      what_to_do: 'Add og:title, og:description, og:image, og:url to every page. Use a high-quality service photo as the OG image.',
      impact: 3,
      effort: 1,
    });
  }

  // Authority — press mentions / backlinks
  if (auth !== undefined && (auth.backlink_sample_count ?? 0) < 10) {
    recs.push({
      template_id: 'press_mentions',
      title: 'Build authority through press coverage and directory listings',
      why: `Only ${auth.backlink_sample_count ?? 0} external backlinks found — low authority reduces both Google ranking and LLM citation likelihood.`,
      what_to_do: 'Get listed on industry-relevant directories and local business listings (Google Business Profile, Yelp, industry associations). Pitch one expert story to a trade or local publication each quarter. Each quality backlink lifts both rankings and AI citation probability.',
      impact: 4,
      effort: 3,
    });
  }

  // Slow response time
  if (tech?.response_time_ms && tech.response_time_ms > 2000) {
    recs.push({
      template_id: 'page_speed',
      title: 'Improve page load speed — current TTFB is too slow',
      why: `TTFB of ${tech.response_time_ms}ms detected — slow sites are penalised in Core Web Vitals and crawl budget.`,
      what_to_do: 'Enable Cloudflare caching or a CDN. Compress images, defer non-critical JS. Target TTFB under 800ms. Check GTmetrix monthly.',
      impact: 3,
      effort: 3,
    });
  }

  // Content: thin page (critical for GEO)
  if (content !== undefined && (content.word_count ?? 0) < 300) {
    recs.push({
      template_id: 'expand_service_pages',
      title: 'Expand thin homepage content — current word count too low for GEO',
      why: `Only ${content.word_count ?? 0} words detected. AI engines require substantive content (300+ words) to consider a page citation-worthy.`,
      what_to_do: 'Add dedicated sections for each service with specific facts, FAQs, pricing, and outcomes. Aim for 600+ words on service pages. Write for people, structure for machines.',
      impact: 5,
      effort: 2,
    });
  }

  // Content: no phone number (local SEO critical)
  if (content !== undefined && !content.has_phone) {
    recs.push({
      template_id: 'gbp_populate',
      title: 'Add phone number and contact details to homepage',
      why: 'No phone number detected on homepage — LLMs and local search engines expect contact information for local businesses.',
      what_to_do: 'Add a visible phone number in international E.164 format (+1..., +44..., +61..., etc.) in the header, footer, and a dedicated contact section. Mark it up with schema.org/telephone.',
      impact: 4,
      effort: 1,
    });
  }

  // Content: images missing alt text
  if (content !== undefined && (content.alt_coverage_pct ?? 100) < 80) {
    recs.push({
      template_id: 'expand_service_pages',
      title: 'Fix missing image alt text across the site',
      why: `${100 - (content.alt_coverage_pct ?? 100)}% of images lack alt text — search engines and screen readers cannot interpret these images.`,
      what_to_do: 'Add descriptive alt text to every <img> tag describing what the image shows, not generic "photo" or empty strings. Use keywords naturally.',
      impact: 3,
      effort: 1,
    });
  }

  // Validate all template_ids are in the library
  const validIds = new Set(RECOMMENDATION_TEMPLATES.map((t) => t.id));
  const filtered = recs.filter((r) => validIds.has(r.template_id));

  // Sort by impact/effort ratio descending
  filtered.sort((a, b) => b.impact / b.effort - a.impact / a.effort);

  return filtered.slice(0, 8);
}

