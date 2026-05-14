export interface SchemaAuditResult {
  schemas_found: string[];
  coverage: Record<string, boolean>;
  issues: string[];
  score: number;
  schemas_raw: object[];
  is_ecommerce: boolean;
  ecommerce_coverage: Record<string, boolean>;
}

const REQUIRED_SCHEMAS = [
  'LocalBusiness',
  'Service',
  'FAQPage',
  'BreadcrumbList',
  'Organization',
];

const ECOMMERCE_SCHEMAS = ['Product', 'Offer', 'Review', 'AggregateRating', 'ItemList'];
const ECOMMERCE_PRODUCT_FIELDS = ['name', 'description', 'image', 'offers', 'sku'];

const LOCAL_BUSINESS_FIELDS = ['name', 'address', 'telephone', 'openingHours', 'sameAs', 'url'];

export async function runSchemaAudit(domain: string, html: string): Promise<SchemaAuditResult> {
  const issues: string[] = [];
  const schemasFound: string[] = [];
  const coverage: Record<string, boolean> = {};

  if (!html) {
    return { schemas_found: [], coverage: {}, issues: ['No page content available'], score: 0, schemas_raw: [], is_ecommerce: false, ecommerce_coverage: {} };
  }

  const jsonLdBlocks = extractJsonLd(html);
  const allTypes: string[] = [];
  const schemasRaw: object[] = [];

  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block);
      schemasRaw.push(parsed);
      const types = extractTypes(parsed);
      allTypes.push(...types);

      // Check LocalBusiness completeness
      if (types.includes('LocalBusiness') || types.includes('Organization')) {
        const missingFields = LOCAL_BUSINESS_FIELDS.filter(f => !block.includes(`"${f}"`));
        if (missingFields.length > 0) {
          issues.push(`LocalBusiness schema missing fields: ${missingFields.join(', ')}`);
        }
      }

      // Check Product completeness for e-commerce
      if (types.includes('Product')) {
        const missingProdFields = ECOMMERCE_PRODUCT_FIELDS.filter(f => !block.includes(`"${f}"`));
        if (missingProdFields.length > 0) {
          issues.push(`Product schema missing fields: ${missingProdFields.join(', ')} — affects Shopping rich results`);
        }
      }
    } catch {
      issues.push('Malformed JSON-LD block found');
    }
  }

  const uniqueTypes = [...new Set(allTypes)];
  schemasFound.push(...uniqueTypes);

  // Opportunity coverage — only flag schemas relevant to this site type
  const hasOrgOrLocal = uniqueTypes.some(t => ['Organization','LocalBusiness','Corporation'].includes(t));
  const hasLocal      = uniqueTypes.some(t => t.includes('LocalBusiness'));
  for (const schema of REQUIRED_SCHEMAS) {
    const present = uniqueTypes.some((t) => t.includes(schema));
    coverage[schema] = present;
    // LocalBusiness only flagged as missing for sites without Organization-level schema
    if (!present && !(schema === 'LocalBusiness' && hasOrgOrLocal)) {
      issues.push(`Missing ${schema} schema`);
    }
  }

  // E-commerce detection: rely only on schema types — HTML text search produces too many false positives
  const is_ecommerce = ECOMMERCE_SCHEMAS.some(s => uniqueTypes.includes(s));

  const ecommerce_coverage: Record<string, boolean> = {};
  if (is_ecommerce) {
    for (const s of ECOMMERCE_SCHEMAS) {
      ecommerce_coverage[s] = uniqueTypes.includes(s);
      if (!uniqueTypes.includes(s)) {
        issues.push(`E-commerce: Missing ${s} schema — needed for Google Shopping rich results`);
      }
    }
  }

  // Scoring: signal-based, not a rigid checklist — rewards depth over a fixed schema list
  let score = 0;
  if (schemasFound.length > 0)  score += 20; // has any schema markup
  if (hasOrgOrLocal)            score += 25; // identity schema (Org or LocalBusiness)
  if (hasLocal)                 score += 5;  // bonus for LocalBusiness specifically
  if (uniqueTypes.includes('WebSite'))       score += 10;
  if (uniqueTypes.includes('FAQPage'))       score += 20;
  if (uniqueTypes.includes('BreadcrumbList')) score += 10;
  if (uniqueTypes.some(t => ['Service','Product','Article','HowTo','SoftwareApplication'].includes(t))) score += 15;
  if (uniqueTypes.some(t => ['Person','ContactPoint','PostalAddress','Place'].includes(t))) score += 5;
  score = Math.min(100, score);

  return { schemas_found: schemasFound, coverage, issues, score, schemas_raw: schemasRaw, is_ecommerce, ecommerce_coverage };
}

function extractJsonLd(html: string): string[] {
  const blocks: string[] = [];

  // Primary: explicit application/ld+json script tags
  const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    const trimmed = match[1].trim();
    if (trimmed) blocks.push(trimmed);
  }

  // Secondary: scan inline <script> and JSON blobs for embedded schema objects.
  // Many React/Next.js apps serialize schema into __NEXT_DATA__ or window.__SCHEMA__ etc.
  // Pattern: finds any JSON object that has both @context (schema.org) and @type at the top level.
  if (blocks.length === 0) {
    const schemaPattern = /\{"@context"\s*:\s*"https?:\/\/(?:www\.)?schema\.org[^"]*"[^{}]*"@type"\s*:\s*"[^"]+"/g;
    // Extract up to 5 candidate objects by tracking brace depth
    let pm;
    let attempts = 0;
    while ((pm = schemaPattern.exec(html)) !== null && attempts < 10) {
      attempts++;
      // Walk forward from the match start to find the complete JSON object
      let depth = 0; let start = pm.index; let i = start;
      for (; i < html.length && i < start + 8000; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) break; }
      }
      if (depth === 0 && i > start) {
        const candidate = html.slice(start, i + 1);
        try {
          JSON.parse(candidate); // validate it's real JSON
          blocks.push(candidate);
        } catch { /* not valid JSON — skip */ }
      }
    }
  }

  return blocks;
}

function extractTypes(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const types: string[] = [];
  const o = obj as Record<string, unknown>;
  if (o['@type']) {
    const t = o['@type'];
    if (typeof t === 'string') types.push(t);
    else if (Array.isArray(t)) types.push(...t);
  }
  for (const val of Object.values(o)) {
    if (typeof val === 'object') types.push(...extractTypes(val));
  }
  return types;
}
