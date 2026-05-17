import { fetchWithTimeout } from '../lib/http';

export interface AuthorityResult {
  domain_age_years: number | null;
  wayback_first_seen: string | null;
  wikipedia: boolean;
  wikidata_id: string | null;
  indexed_page_count: number | null;
  registration_date: string | null;
  page_rank: number | null;
  issues: string[];
}

export async function runAuthority(domain: string, businessName: string, openpagerank_key?: string): Promise<AuthorityResult> {
  const issues: string[] = [];

  // Common Crawl removed — saved 2 subrequests/invocation (stayed under CF Workers 50 limit).
  const [wayback, wikipedia, wikidata, rdap, opr] = await Promise.allSettled([
    fetchWayback(domain),
    fetchWikipedia(businessName),
    fetchWikidata(businessName),
    fetchRdap(domain),
    openpagerank_key ? fetchOpenPageRank(domain, openpagerank_key) : Promise.resolve(null),
  ]);

  const waybackDate = wayback.status === 'fulfilled' ? wayback.value : null;
  const wikipediaPresent = wikipedia.status === 'fulfilled' ? wikipedia.value : false;
  const wikidataId = wikidata.status === 'fulfilled' ? wikidata.value : null;
  const regDate = rdap.status === 'fulfilled' ? rdap.value : null;
  const pageRank = opr.status === 'fulfilled' ? opr.value : null;

  const domainAgeYears = regDate
    ? Math.floor((Date.now() - new Date(regDate).getTime()) / (1000 * 60 * 60 * 24 * 365))
    : null;

  if (!wikipediaPresent) issues.push('No Wikipedia page — low entity authority signal');
  if (!wikidataId) issues.push('No Wikidata entity — reduces LLM training-data inclusion likelihood');
  if (domainAgeYears !== null && domainAgeYears < 2) issues.push(`Domain only ${domainAgeYears} year(s) old — low trust signal`);

  return {
    domain_age_years: domainAgeYears,
    wayback_first_seen: waybackDate,
    wikipedia: wikipediaPresent,
    wikidata_id: wikidataId,
    indexed_page_count: null,   // Common Crawl removed to save subrequests — null = not checked
    registration_date: regDate,
    page_rank: pageRank,
    issues,
  };
}

async function fetchOpenPageRank(domain: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://openpagerank.com/api/v1.0/getPageRank?domains[0]=${encodeURIComponent(domain)}`,
      { timeoutMs: 8000, headers: { 'API-OPR': apiKey } }
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      response?: Array<{ page_rank_decimal?: number; status_code?: number }>;
    };
    const entry = data.response?.[0];
    if (!entry || entry.status_code !== 200) return null;
    return entry.page_rank_decimal ?? null;
  } catch {
    return null;
  }
}

async function fetchWayback(domain: string): Promise<string | null> {
  const url = `https://web.archive.org/cdx/search/cdx?url=${domain}&limit=1&output=json&fl=timestamp&from=19900101`;
  const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
  if (!res.ok) return null;
  const data: string[][] = await res.json();
  if (!data || data.length < 2) return null;
  const ts = data[1][0];
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

// Derive a clean brand name from a domain: 'hubspot.com' → 'hubspot'
function brandFromDomain(domain: string): string {
  return domain.replace(/^www\./, '').split('.')[0].toLowerCase();
}

async function fetchWikipedia(name: string): Promise<boolean> {
  // name may be the full domain (e.g. "hubspot.com"); derive the brand slug
  const brand = brandFromDomain(name);
  // Normalize to alphanumeric — handles apostrophes ("mcdonald's" → "mcdonalds") and
  // abbreviation redirects. Without redirects=resolve, OpenSearch returns the redirect
  // page title itself (e.g. "Nytimes" for "nytimes.com") rather than its target
  // ("The New York Times"), making the brand slug match far more likely to succeed.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normBrand = norm(brand);
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(brand)}&limit=5&format=json`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 6000 });
    if (!res.ok) return false;
    const data = await res.json() as [string, string[], string[], string[]];
    const titles: string[] = data[1] ?? [];
    return titles.some(t => {
      const nt = norm(t);
      // Accept exact match or "Brand Something" prefix — reject "XyzBrand" or "something brand"
      return nt === normBrand || nt.startsWith(normBrand + ' ') || nt.startsWith(normBrand + '-');
    });
  } catch { return false; }
}

async function fetchWikidata(name: string): Promise<string | null> {
  // Use entity search API — much more reliable than exact SPARQL label match
  const brand = brandFromDomain(name);
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(brand)}&language=en&limit=5&format=json`;
  // Normalize to alphanumeric — handles apostrophes ("McDonald's" → "mcdonalds")
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normBrand = norm(brand);
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
    if (!res.ok) return null;
    const data = await res.json() as {
      search?: Array<{ id: string; label?: string; description?: string; match?: { type?: string } }>;
    };
    if (!data.search?.length) return null;
    // Priority 1: label or alias match with a company-type description
    const companyMatch = data.search.find(e => {
      const nl = norm(e.label ?? '');
      const labelMatches = nl === normBrand || nl.startsWith(normBrand + ' ') || nl.startsWith(normBrand + '-') || e.match?.type === 'alias';
      return labelMatches && /company|corporation|software|platform|service|organization|business|startup|tech|restaurant|retail|chain|brand|media|entertainment|nonprofit|charity|foundation/i.test(e.description ?? '');
    });
    if (companyMatch) return companyMatch.id;
    // Priority 2: first result matched via label or alias (covers abbreviation redirects
    // like "nytimes" → Q9684 "The New York Times" matched via alias "nytimes")
    const aliasOrLabelMatch = data.search.find(e =>
      e.match?.type === 'label' || e.match?.type === 'alias'
    );
    if (aliasOrLabelMatch) return aliasOrLabelMatch.id;
    // Priority 3: any result whose normalized label starts with the brand slug
    return data.search.find(e => norm(e.label ?? '').startsWith(normBrand))?.id ?? null;
  } catch { return null; }
}

// TLD-specific RDAP servers — mirrors domain_intel.ts
const AUTHORITY_TLD_RDAP: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/domain',
  net: 'https://rdap.verisign.com/net/v1/domain',
  org: 'https://rdap.publicinterestregistry.org/rdap/domain',
  io:  'https://rdap.iana.org/domain',
  co:  'https://rdap.iana.org/domain',
  ai:  'https://rdap.iana.org/domain',
  uk:  'https://rdap.nominet.uk/uk/domain',
  de:  'https://rdap.denic.de/domain',
  fr:  'https://rdap.nic.fr/domain',
  nl:  'https://rdap.sidn.nl/domain',
  au:  'https://rdap.auda.org.au/domain',
  ca:  'https://rdap.cira.ca/domain',
  eu:  'https://rdap.eu/domain',
  app: 'https://rdap.nic.google/domain',
  dev: 'https://rdap.nic.google/domain',
  info:'https://rdap.afilias.net/rdap/domain',
  biz: 'https://rdap.nic.biz/domain',
};

async function fetchRdap(domain: string): Promise<string | null> {
  const tld = domain.split('.').pop()?.toLowerCase() ?? '';
  type RdapBody = { events?: Array<{ eventAction: string; eventDate: string }> };

  const endpoints: string[] = [
    `https://rdap.org/domain/${domain}`,
    `https://rdap.iana.org/domain/${domain}`,
  ];
  if (AUTHORITY_TLD_RDAP[tld]) endpoints.push(`${AUTHORITY_TLD_RDAP[tld]}/${domain}`);

  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, { timeoutMs: 5000 });
      if (!res.ok) continue;
      const data = await res.json() as RdapBody;
      const reg = data.events?.find(e => e.eventAction === 'registration');
      if (reg?.eventDate) return reg.eventDate;
    } catch { /* try next */ }
  }
  return null;
}

