export interface OnPageSeoResult {
  score: number;
  issues: string[];
  headings: HeadingResult;
  links: LinkResult;
  images: ImageResult;
  content: ContentResult;
  page_speed: PageSpeedResult | null;
}

interface HeadingResult {
  h1: number; h2: number; h3: number; h4_plus: number;
  h1_texts: string[];
  skipped_level: boolean;
}

interface LinkResult {
  internal: number; external: number; nofollow: number; total: number;
}

interface ImageResult {
  total: number; missing_alt: number; missing_dimensions: number;
  lazy_loaded: number; modern_format: number; responsive: number;
}

interface ContentResult {
  word_count: number; reading_time_min: number; paragraph_count: number;
  has_faq: boolean; has_table: boolean; has_video: boolean;
}

export interface PageSpeedResult {
  performance: number;
  accessibility: number;
  lcp_s: number | null;
  cls: number | null;
  fcp_s: number | null;
  ttfb_s: number | null;
  tbt_ms: number | null;
  opportunities: string[];
}

const EMPTY: OnPageSeoResult = {
  score: 0, issues: ['Failed to fetch page'],
  headings: { h1: 0, h2: 0, h3: 0, h4_plus: 0, h1_texts: [], skipped_level: false },
  links: { internal: 0, external: 0, nofollow: 0, total: 0 },
  images: { total: 0, missing_alt: 0, missing_dimensions: 0, lazy_loaded: 0, modern_format: 0, responsive: 0 },
  content: { word_count: 0, reading_time_min: 0, paragraph_count: 0, has_faq: false, has_table: false, has_video: false },
  page_speed: null,
};

export async function runOnPageSeo(domain: string, html: string): Promise<OnPageSeoResult> {
  const issues: string[] = [];

  if (!html) return EMPTY;

  // ── Heading hierarchy ─────────────────────────────────────────────────────
  const h1raw = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  const h1count = h1raw.length;
  const h2count = (html.match(/<h2[^>]*>/gi) ?? []).length;
  const h3count = (html.match(/<h3[^>]*>/gi) ?? []).length;
  const h4plus  = (html.match(/<h[456][^>]*>/gi) ?? []).length;
  const h1texts = h1raw.map(m => m[1].replace(/<[^>]+>/g, '').trim().slice(0, 80)).filter(Boolean);
  const skipped_level = h1count > 0 && h2count === 0 && h3count > 0;

  if (h1count === 0)  issues.push('No H1 tag — critical for keyword targeting');
  if (h1count > 1)   issues.push(`${h1count} H1 tags found — should be exactly one`);
  if (h2count === 0) issues.push('No H2 subheadings — page has no content structure');
  if (skipped_level) issues.push('Heading hierarchy skips H2 (H1→H3) — breaks document outline');

  // ── Link analysis ─────────────────────────────────────────────────────────
  let internal = 0, external = 0, nofollow = 0;
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1].trim();
    const tag  = m[0];
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    if (/^https?:\/\//i.test(href) && !href.toLowerCase().includes(domain.toLowerCase())) external++;
    else internal++;
    if (/rel=["'][^"']*nofollow/i.test(tag)) nofollow++;
  }
  if (internal < 3) issues.push(`Only ${internal} internal links — strengthen internal linking for crawlability`);
  if (external > 0 && nofollow / external > 0.8) issues.push('Most external links are nofollowed — consider passing link equity to trusted resources');

  // ── Image audit ──────────────────────────────────────────────────────────
  const imgTags = [...html.matchAll(/<img\s[^>]*>/gi)].map(m => m[0]);
  const totalImgs = imgTags.length;
  let missingAlt = 0, missingDims = 0, lazyLoaded = 0, modernFmt = 0, responsive = 0;
  for (const tag of imgTags) {
    if (!/alt=/i.test(tag) || /alt=["']\s*["']/i.test(tag)) missingAlt++;
    if (!/width=/i.test(tag) || !/height=/i.test(tag)) missingDims++;
    if (/loading=["']lazy["']/i.test(tag)) lazyLoaded++;
    if (/\.(webp|avif)/i.test(tag) || /type=["']image\/(webp|avif)/i.test(tag)) modernFmt++;
    if (/srcset=/i.test(tag)) responsive++;
  }
  if (missingAlt > 0) issues.push(`${missingAlt} image${missingAlt > 1 ? 's' : ''} missing alt text — accessibility & SEO penalty`);
  if (totalImgs > 5 && missingDims > totalImgs * 0.4) issues.push(`${missingDims} images missing width/height attributes — causes Cumulative Layout Shift`);
  if (totalImgs > 4 && lazyLoaded < Math.floor(totalImgs * 0.5)) issues.push('Most images not lazy-loaded — hurts page load speed below the fold');
  if (totalImgs > 0 && modernFmt === 0) issues.push('No WebP/AVIF images detected — modern formats save 25-35% bandwidth');

  // ── Content depth ─────────────────────────────────────────────────────────
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const wordCount = stripped.split(/\s+/).filter(w => w.length > 2).length;
  const readingTime = Math.max(1, Math.ceil(wordCount / 200));
  const paragraphs = (html.match(/<p[^>]*>/gi) ?? []).length;
  const hasFaq    = /faq|frequently.asked|q&a|question.*answer/i.test(html);
  const hasTable  = /<table[^>]*>/i.test(html);
  const hasVideo  = /<video[^>]*>|youtube\.com\/embed|vimeo\.com\/video|loom\.com\/embed/i.test(html);

  if (wordCount < 300) issues.push(`${wordCount} words — thin content (target 600+) is skipped by AI citation engines`);
  else if (wordCount < 600) issues.push(`${wordCount} words — moderate content depth; 600+ words ranks significantly better`);
  if (!hasFaq) issues.push('No FAQ section detected — FAQ schema dramatically boosts AI answer inclusion');

  const page_speed: PageSpeedResult | null = null;

  // ── Score ─────────────────────────────────────────────────────────────────
  const checks = [
    h1count === 1,
    h2count >= 2,
    !skipped_level,
    missingAlt === 0,
    wordCount >= 300,
    internal >= 3,
    totalImgs === 0 || missingDims < totalImgs * 0.5,
  ];
  const score = Math.round(checks.filter(Boolean).length / checks.length * 100);

  return {
    score, issues,
    headings: { h1: h1count, h2: h2count, h3: h3count, h4_plus: h4plus, h1_texts: h1texts, skipped_level },
    links: { internal, external, nofollow, total: internal + external },
    images: { total: totalImgs, missing_alt: missingAlt, missing_dimensions: missingDims, lazy_loaded: lazyLoaded, modern_format: modernFmt, responsive },
    content: { word_count: wordCount, reading_time_min: readingTime, paragraph_count: paragraphs, has_faq: hasFaq, has_table: hasTable, has_video: hasVideo },
    page_speed,
  };
}
