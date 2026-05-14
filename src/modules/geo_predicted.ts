import type { Env } from '../lib/types';
import { callLlm } from '../lib/llm';
import { CITATION_PREDICTOR_SYSTEM, buildCitationPrompt } from '../prompts';
import { isBotChallengePage } from '../lib/bot-detection';

// Models are now managed by lib/llm.ts (CF Workers AI → Groq fallback)

export interface GeoPredictedResult {
  queries: QueryPrediction[];
  citation_rate: number;
  avg_confidence: number;
  vertical?: string;
  location?: string;
  vertical_override_applied: boolean;
  /** false when AI was unavailable and all queries are generic templates — module should be suppressed */
  is_reliable: boolean;
}

export interface QueryPrediction {
  query: string;
  cited: boolean;
  confidence: number;
  reasoning: string;
}

// 3 queries per vertical — run sequentially with primary → fallback → heuristic chain
const QUERY_TEMPLATES: Record<string, string[]> = {
  dental: [
    'best dental clinic in {location}',
    'emergency dentist {location}',
    'dental implants cost {location}',
  ],
  legal: [
    'best law firm in {location}',
    'employment lawyer {location}',
    'business lawyer {location}',
  ],
  fitness: [
    'best gym in {location}',
    'personal trainer {location}',
    'yoga studio {location}',
  ],
  real_estate: [
    'best real estate agent {location}',
    'buy apartment {location}',
    'rent house {location}',
  ],
  hotel: [
    'best luxury hotel {location}',
    'boutique hotel {location}',
    'weekend getaway {location}',
  ],
  restaurant: [
    'best restaurant in {location}',
    'fine dining {location}',
    'Sunday brunch {location}',
  ],
  food_delivery: [
    'best food delivery service {location}',
    'order food online {location}',
    'fast food delivery {location}',
  ],
  medical: [
    'best private clinic {location}',
    'specialist doctor {location}',
    'urgent care clinic {location}',
  ],
  ecommerce: [
    'best online store {location}',
    'fast delivery {location}',
    'top rated shop {location}',
  ],
  finance: [
    'best financial advisor {location}',
    'ai trading platform review',
    'investment app {location}',
  ],
  tech: [
    'best saas platform review',
    'top software tools for business',
    'ai software platform {location}',
  ],
  education: [
    'best online learning platform',
    'top language learning app',
    'best e-learning platform {location}',
  ],
  general: [
    'top rated service provider {location}',
    'trusted company {location}',
    'professional services {location}',
  ],
};

const KNOWN_CITIES = [
  'London','New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia',
  'San Antonio','San Diego','Dallas','San Jose','Austin','Jacksonville',
  'Toronto','Montreal','Vancouver','Calgary','Edmonton',
  'Sydney','Melbourne','Brisbane','Perth','Adelaide',
  'Singapore','Hong Kong','Tokyo','Osaka','Seoul','Shanghai','Beijing','Mumbai',
  'Bangalore','Delhi','Hyderabad','Chennai','Kolkata',
  'Paris','Berlin','Amsterdam','Madrid','Barcelona','Rome','Milan','Vienna',
  'Zurich','Geneva','Brussels','Stockholm','Oslo','Copenhagen','Helsinki',
  'Dubai','Abu Dhabi','Riyadh','Doha','Kuwait City','Manama','Muscat',
  'Cairo','Nairobi','Lagos','Cape Town','Johannesburg',
  'São Paulo','Buenos Aires','Mexico City','Bogotá','Lima','Santiago',
];

// Common English words that the "in <Word>" regex would false-positive on
// Each word is checked individually so multi-word phrases like "Early Access" are caught too
const LOCATION_STOP = new Set([
  'start','started','starting','free','trial','your','just','more','join','find','meet',
  'help','from','with','this','that','they','some','most','many','each','here','there',
  'where','about','when','what','how','why','who','which','our','the','its','has','can',
  'get','new','see','try','use','all','any','and','but','for','not','you','one','two',
  'app','web','site','us','uk','ca','au','me','inc','llc','ltd','now','soon','days',
  'minutes','seconds','hours','weeks','months','years','service','services','business',
  'company','platform','product','products','feature','features','solution','solutions',
  'pricing','contact','login','signup','account','team','careers','blog','news',
  // Product-status / lifecycle words that commonly appear in "in <Word>" phrases
  'early','access','beta','alpha','preview','launch','release','development','testing',
  'production','staging','progress','maintenance','review',
  'private','public','open','closed','limited','general','global','worldwide','built',
  'real','time','live','demo','coming','motion',
  // Navigation / UI words that appear as headings/links (e.g. "Discover", "Explore")
  'discover','explore','browse','search','create','design','build','connect','learn',
  'work','play','feed','store','shop','market','studio','lab','hub','center','centre',
  'community','network','portfolio','gallery','library','trending','featured','popular',
  'latest','top','best','all','inspiration','showcase','hire','jobs','pricing',
  // Common sentence openers that follow "in" in marketing copy
  'which','ways','terms','seconds','minutes','hours','style','line','touch','stock',
  'depth','detail','progress','action','full','use','short','summary','brief',
  // Login / CTA words that appear capitalized in nav ("Sign in", "Log in", "Opt in")
  'sign','log','fill','opt','plug','check','trade','dial','tune','factor',
]);

export function detectLocation(content: string): string {
  const lower = content.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (lower.includes(city.toLowerCase())) return city;
  }
  // Fallback: try to extract "in <City>" pattern — exclude common English false positives.
  // Check every word of the captured phrase against LOCATION_STOP so multi-word phrases
  // like "Early Access" or "Open Beta" don't get treated as city names.
  const m = content.match(/\bin\s+([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+)?)\b/);
  if (m) {
    const words = m[1].toLowerCase().split(/\s+/);
    if (!words.some(w => LOCATION_STOP.has(w))) return m[1];
  }
  return 'your area';
}

export function detectVertical(content: string): string {
  const lower = content.toLowerCase();
  // Business directories — detect first to prevent vertical misclassification
  // (directories list every type of business in their descriptions)
  if (/\b(yellow pages|yellowpages|whitepages|business directory|local business listings|find local businesses|business finder|company directory|yelp|tripadvisor|trustpilot)\b/i.test(lower)) return 'general';
  // Education / language learning
  if (/\b(language learning|learn (a )?language|learn (spanish|french|german|italian|japanese|chinese|korean|portuguese|arabic|russian|hindi)|language (course|lesson|class|tutor)|language school|fluent|fluency|vocabulary|grammar lesson|pronunciation|e-?learning platform|online course|online learning|mooc|edtech|tutoring platform|coding bootcamp|online academy|learning management)\b/i.test(lower)) return 'education';
  // AI assistant / AI productivity tools — catch before broader SaaS checks
  if (/\b(ai assistant|ai agent|llm|large language model|generative ai|gpt|copilot|chatbot|voice assistant|personal ai|ai.{0,15}(does|runs|works|builds|manages)|autonomous agent|agentic|multi.?agent)\b/i.test(lower)) return 'tech';
  // Developer productivity tools, AI coding tools, macOS/desktop apps for developers
  if (/\b(claude code|claude ai|macos app|menu bar app|developer workflow|code editor|terminal emulator|multi.?session|multi.?account|ide extension|vscode|github copilot|developer productivity|coding tool|coding assistant|developer utility|desktop app for)\b/i.test(lower)) return 'tech';
  // Tech/SaaS checked first — generic terms like "menu", "food", "store" appear in any site's HTML
  if (/saas|software platform|developer tools|devops|cloud platform|open.?source|repository|repositories|pull request|version control/.test(lower)) return 'tech';
  // API check tightened — require deploy/sdk/endpoint, not generic "platform"/"software" which appear everywhere
  if (/api\b/.test(lower) && /\b(deploy|sdk|endpoint|webhook|developer portal)\b/.test(lower)) return 'tech';
  // Broader SaaS/marketing platform signals (catches HubSpot, Ahrefs, Semrush, Hootsuite, etc.)
  if (/\b(marketing platform|marketing software|marketing hub|sales software|sales hub|crm platform|crm software|analytics platform|seo (tools?|platform)|rank tracker|backlink checker|ai marketing|marketing automation|hris|workforce management software)\b/i.test(lower)) return 'tech';
  // CRM/business software with named hubs (HubSpot "Marketing Hub", "Sales Hub", etc.)
  if (/\b(crm|inbound marketing|marketing hub|sales hub|service hub|cms hub)\b/.test(lower) && /\bsoftware\b/.test(lower)) return 'tech';
  // Software & Tools companies (HubSpot title: "Software & Tools for your Business")
  if (/\bsoftware\b.{0,40}\btools?\b|\btools?\b.{0,40}\bsoftware\b/i.test(lower) && /\b(business|marketing|sales|customer|service|team)\b/.test(lower)) return 'tech';
  if (/dental|dentist|teeth|tooth|orthodont|implant|braces/.test(lower)) return 'dental';
  // Ecommerce platforms — checked before finance because store builders (Shopify, WooCommerce)
  // use payment language but are not financial services companies
  if (/\b(sell online|online store|ecommerce platform|start your (free )?store|build your (online )?store|commerce platform|shopify|woocommerce)\b/i.test(lower)) return 'ecommerce';
  if (/\b(add to cart|add to bag|buy now|shopping cart)\b/i.test(lower)) return 'ecommerce';
  // Finance/payments — tightened with word boundaries to avoid false positives from words like
  // "investigate" (invest), "fundamental" (fund), "trade-off" (trade), "trademark" (trade)
  if (/payment.{0,25}(platform|gateway|processing|infrastructure|api)|financial.{0,25}(infrastructure|technology|platform|services)|\bfintech\b|\bstock market\b|\bcrypto(currency)?\b|\bforex\b|\b(hedge|mutual|index) fund\b|\bwealth management\b|\bfinancial.?advis|\btrading (platform|software|bot|signal|strategy|app)\b|\binvestment (platform|app|fund|portfolio|management)\b|\bportfolio management\b|\bpay.?day loan\b|\binsurance (platform|quote|policy)\b/.test(lower)) return 'finance';
  // Hotel: only clear hotel-specific terms — "suite" and "check-in" removed as too generic
  if (/\bhotel\b|\bresort\b|\baccommodation\b|\blodging\b/.test(lower)) return 'hotel';
  // Food delivery — check before restaurant; halal sites and explicit delivery services often misclassify as restaurant
  if (/\bhalal\b/i.test(lower) && /\bdeliver/i.test(lower)) return 'food_delivery';
  if (/\b(food delivery service|meal delivery|grocery delivery|order food online)\b/i.test(lower)) return 'food_delivery';
  // Restaurant: require specific culinary terms — avoid "menu" and "food" which appear in nav/generic HTML
  if (/restaurant|cuisine|chef|bistro|eatery|takeaway|takeout|brunch|dining room|dine in|fine dining/.test(lower)) return 'restaurant';
  if (/burger|pizza|sushi|chicken wings|grill house|café/.test(lower)) return 'restaurant';
  // Fitness: require specific terms — bare "fitness" in a board listing (4chan /fit/) would otherwise misclassify
  if (/\b(gym|yoga|crossfit|pilates|personal.?train|bodybuilding|weight.?loss|workout routine|fitness coach|fitness studio|fitness centre|fitness center)\b/.test(lower)) return 'fitness';
  // Legal: require specific practitioner terms — bare "legal" appears in every site's footer (Terms of Use, etc.)
  if (/lawyer|law firm|attorney|solicitor|advocate|legal advice|legal services|legal counsel/.test(lower)) return 'legal';
  if (/real estate|property listing|apartment for|villa for|mortgage broker/.test(lower)) return 'real_estate';
  if (/clinic|medical practice|doctor|hospital|pharma|specialist/.test(lower)) return 'medical';
  return 'general';
}

async function callModel(
  query: string,
  pageContent: string,
  env: Env
): Promise<QueryPrediction | null> {
  const text = await callLlm([
    { role: 'system', content: CITATION_PREDICTOR_SYSTEM },
    { role: 'user', content: buildCitationPrompt(query, pageContent) },
  ], 256, env);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]) as {
    cited: boolean; confidence: number; reasoning: string;
  };
  const confidence = Math.min(1, Math.max(0, parsed.confidence ?? 0));
  return {
    query,
    cited: (parsed.cited ?? false) || confidence >= 0.35,
    confidence,
    reasoning: parsed.reasoning ?? '',
  };
}

function heuristicScore(query: string, pageContent: string): QueryPrediction {
  const lower = pageContent.toLowerCase();
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const termMatches = queryWords.filter(t => lower.includes(t)).length;

  let score = queryWords.length > 0 ? (termMatches / queryWords.length) * 0.15 : 0;
  if (/\b\d[\d\s\-().]{7,}\d\b/.test(pageContent))                              score += 0.10; // phone
  if (/\d+\s+\w+\s+(street|st\.?|avenue|ave\.?|road|rd\.?|blvd)/i.test(pageContent)) score += 0.05; // address
  if (lower.includes('application/ld+json'))                                     score += 0.10; // schema
  if (/review|rating|\bstars?\b|testimonial/i.test(lower))                       score += 0.05; // social proof
  if (/contact|about[-\s]us|our team/i.test(lower))                              score += 0.03; // trust

  const confidence = Math.min(0.28, Math.round(score * 100) / 100);
  return {
    query,
    cited: false,
    confidence,
    reasoning: `AI unavailable — heuristic: ${termMatches}/${queryWords.length} query terms matched; ${confidence >= 0.1 ? 'structured signals present' : 'few signals found'}`,
  };
}

const VERTICAL_NAMES = [
  'dental','legal','fitness','real_estate','hotel','restaurant','food_delivery',
  'medical','ecommerce','finance','tech','education','general',
] as const;

/**
 * AI fallback for vertical classification — called only when regex returns 'general'
 * and there is enough content to reason about. One tiny LLM call (max_tokens: 15).
 */
async function aiClassifyVertical(content: string, env: Env): Promise<string> {
  try {
    const snippet = content.slice(0, 500);
    const raw = (await callLlm([
      {
        role: 'system',
        content: `You are a website classifier. Respond with ONLY one of these exact labels (use underscores as shown):\ndental, legal, fitness, real_estate, hotel, restaurant, food_delivery, medical, ecommerce, finance, tech, education, general\n\nNo other text, no punctuation.`,
      },
      {
        role: 'user',
        content: `Classify this website:\n${snippet}`,
      },
    ], 15, env)).trim().toLowerCase();

    // Exact match (handles correct responses)
    if ((VERTICAL_NAMES as readonly string[]).includes(raw)) return raw;

    // Strip-and-compare (handles "real estate" → "real_estate", "food delivery" → "food_delivery")
    const stripped = raw.replace(/[\s_\-]/g, '');
    for (const v of VERTICAL_NAMES) {
      if (v.replace('_', '') === stripped) return v;
    }

    // Keyword hints for common LLM paraphrases
    if (/\b(tech|software|saas|startup|app\b|platform|developer|digital|ai\b|tool)/i.test(raw)) return 'tech';
    if (/real.?estate|property|realtor|housing/i.test(raw))                                      return 'real_estate';
    if (/food.?deliv|deliv.?food|takeaway|takeout/i.test(raw))                                   return 'food_delivery';
    if (/hotel|resort|lodg|accommodation/i.test(raw))                                            return 'hotel';
    if (/restaurant|dining|cuisine|bistro/i.test(raw))                                           return 'restaurant';
    if (/fitness|gym|yoga|workout/i.test(raw))                                                   return 'fitness';
    if (/legal|law\b|attorney|solicitor/i.test(raw))                                             return 'legal';
    if (/medical|health|clinic|doctor|hospital/i.test(raw))                                      return 'medical';
    if (/dental|dentist|teeth/i.test(raw))                                                       return 'dental';
    if (/ecommerce|e-commerce|shop\b|store|commerce/i.test(raw))                                 return 'ecommerce';
    if (/finance|financial|invest|bank|trading/i.test(raw))                                      return 'finance';
    if (/education|learning|course|school|tutor/i.test(raw))                                     return 'education';

    return 'general';
  } catch {
    return 'general';
  }
}

/**
 * Generate 3 business-specific GEO queries via AI, using page content to understand
 * what the site actually does. This avoids generic vertical queries like
 * "best financial advisor London" for Stripe (which is a payment processor).
 * Falls back to template queries if AI is unavailable or returns bad output.
 */

/**
 * Detect Cloudflare / bot-challenge / unsupported-client pages from their visible text.
 * These pages contain zero useful business content — passing them to the LLM produces
 * nonsense queries (e.g. "Cordova app integration" for Canva).
 */
// isBotChallengePage is imported from ../lib/bot-detection (single source of truth)

async function generateAiGeoQueries(
  vertical: string,
  location: string,
  pageContent: string,
  env: Env,
): Promise<string[]> {
  try {
    const locStr = (location && location !== 'your area') ? ` (city: ${location})` : '';
    const snippet = pageContent.slice(0, 800);
    const text = await callLlm([
      {
        role: 'system',
        content: 'You are an SEO expert. Output ONLY a JSON array. No markdown, no explanation.',
      },
      {
        role: 'user',
        content: `Generate exactly 3 search queries that an AI (ChatGPT, Perplexity, Google AI) would answer by citing THIS specific business.\n\nVertical: ${vertical}${locStr}\nPage content: ${snippet}\n\nRules:\n- Queries must reflect what this business ACTUALLY does (not generic vertical queries)\n- Use real search language ("best X for Y", "how to Z", "X vs Y")\n- Only include city/location if this is clearly a local business (restaurant, clinic, gym); for global SaaS/brands omit location\n- Mix query types: review/comparison, how-to, and best-of\n\nReturn ONLY a JSON array of exactly 3 strings, e.g. ["best payment API for startups","how to accept credit cards online","stripe vs paypal comparison"]`,
      },
    ], 250, env);
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown[];
    const queries = parsed
      .filter((q): q is string => typeof q === 'string' && q.length > 5)
      .slice(0, 3);
    // Sanity check: reject if any query contains generic filler
    if (queries.some(q => /\{location\}|your area|generic/i.test(q))) return [];
    return queries;
  } catch {
    return [];
  }
}

export async function runGeoPredicted(
  domain: string,
  env: Env,
  sharedHtml: string,
  verticalOverride?: string | null,
  locationOverride?: string | null,
): Promise<GeoPredictedResult> {
  let pageContent = '';
  if (sharedHtml) {
    // Extract title + meta description + OG description from <head> before stripping —
    // these are server-rendered even on JS SPAs and are the most reliable vertical signal.
    const titleText  = (sharedHtml.match(/<title[^>]*>([^<]{0,200})<\/title>/i) ?? [])[1] ?? '';
    const descText   = (sharedHtml.match(/name=["']description["'][^>]*content=["']([^"']{0,300})["']/i) ??
                        sharedHtml.match(/content=["']([^"']{0,300})["'][^>]*name=["']description["']/i) ?? [])[1] ?? '';
    const ogDescText = (sharedHtml.match(/property=["']og:description["'][^>]*content=["']([^"']{0,300})["']/i) ??
                        sharedHtml.match(/content=["']([^"']{0,300})["'][^>]*property=["']og:description["']/i) ?? [])[1] ?? '';
    const metaSignals = `${titleText} ${descText} ${ogDescText}`;
    const bodyText = sharedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
    pageContent = `${metaSignals} ${bodyText}`.trim();
  } else {
    pageContent = `Business at ${domain}`;
  }

  // ── Bot-challenge detection ─────────────────────────────────────────────────
  // Sites like Canva serve "Unsupported client" or Cloudflare challenge pages.
  // Sending that HTML to the LLM produces nonsense queries.
  // If blocked, fall back to a domain-only signal — vertical templates will cover
  // query generation and is_reliable will be false so the UI can handle gracefully.
  if (isBotChallengePage(pageContent)) {
    pageContent = `Business at ${domain}`;
  }

  let vertical = verticalOverride ?? detectVertical(pageContent);
  // AI fallback: regex returns 'general' for niche/unknown sites → ask the LLM
  if (!verticalOverride && vertical === 'general' && pageContent.length > 300) {
    const aiV = await aiClassifyVertical(pageContent, env);
    if (aiV !== 'general') vertical = aiV;
  }
  // Location is only meaningful for local-service verticals.
  // Global SaaS/tech/finance/ecommerce sites mention cities in blog posts and testimonials,
  // so detectLocation produces false positives (e.g. "London" for moz.com).
  const LOCAL_VERTICALS = new Set(['dental','legal','fitness','real_estate','hotel','restaurant','food_delivery','medical']);
  const location = locationOverride ?? (LOCAL_VERTICALS.has(vertical) ? detectLocation(pageContent) : 'your area');
  const overrideApplied = !!(verticalOverride || locationOverride);

  // Try AI-generated business-specific queries first — fall back to templates
  let queries: string[] = [];
  let aiQueriesGenerated = false;
  if (pageContent.length > 150) {
    queries = await generateAiGeoQueries(vertical, location, pageContent, env);
    aiQueriesGenerated = queries.length > 0;
  }
  // Fill remaining slots from templates (strip {location} when location is unknown)
  if (queries.length < 3) {
    const templates = QUERY_TEMPLATES[vertical] ?? QUERY_TEMPLATES.general;
    const fallback = templates.map(t => {
      if (!location || location === 'your area') {
        // Remove the {location} token and any trailing space
        return t.replace(/\s*\{location\}/g, '').trim();
      }
      return t.replace('{location}', location);
    });
    for (const fq of fallback) {
      if (queries.length >= 3) break;
      if (fq && !queries.includes(fq)) queries.push(fq);
    }
  }

  // Halal food delivery — override with domain-specific queries
  if (vertical === 'food_delivery' && /\bhalal\b/i.test(pageContent)) {
    const loc = location !== 'your area' ? location : '';
    queries = [
      `halal food delivery${loc ? ' ' + loc : ''}`,
      `best halal delivery service${loc ? ' ' + loc : ''}`,
      `halal meat delivery near me`,
    ];
  }

  // Run queries sequentially — parallel AI calls hit Cloudflare Workers AI concurrency limits
  const predictions: QueryPrediction[] = [];
  for (const query of queries) {
    let prediction: QueryPrediction | null = null;

    try {
      prediction = await callModel(query, pageContent, env);
    } catch {
      prediction = null;
    }

    // Heuristic if AI unavailable
    predictions.push(prediction ?? heuristicScore(query, pageContent));
  }

  const citedCount = predictions.filter((p) => p.cited).length;
  const citation_rate = predictions.length > 0 ? citedCount / predictions.length : 0;
  const avg_confidence =
    predictions.length > 0
      ? predictions.reduce((s, p) => s + p.confidence, 0) / predictions.length
      : 0;

  return {
    queries: predictions,
    citation_rate,
    avg_confidence,
    vertical,
    location,
    vertical_override_applied: overrideApplied,
    // Only reliable when AI generated queries — template fallback produces generic non-specific results
    is_reliable: aiQueriesGenerated,
  };
}
