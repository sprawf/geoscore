import { fetchWithTimeout } from '../lib/http';

export interface AuthorityResult {
  domain_age_years: number | null;
  wayback_first_seen: string | null;
  wikipedia: boolean;
  wikidata_id: string | null;
  backlink_sample_count: number;
  registration_date: string | null;
  page_rank: number | null;
  issues: string[];
}

export async function runAuthority(domain: string, businessName: string, openpagerank_key?: string): Promise<AuthorityResult> {
  const issues: string[] = [];

  const [wayback, wikipedia, wikidata, rdap, commonCrawl, opr] = await Promise.allSettled([
    fetchWayback(domain),
    fetchWikipedia(businessName),
    fetchWikidata(businessName),
    fetchRdap(domain),
    fetchCommonCrawl(domain),
    openpagerank_key ? fetchOpenPageRank(domain, openpagerank_key) : Promise.resolve(null),
  ]);

  const waybackDate = wayback.status === 'fulfilled' ? wayback.value : null;
  const wikipediaPresent = wikipedia.status === 'fulfilled' ? wikipedia.value : false;
  const wikidataId = wikidata.status === 'fulfilled' ? wikidata.value : null;
  const regDate = rdap.status === 'fulfilled' ? rdap.value : null;
  const backlinkCount = commonCrawl.status === 'fulfilled' ? commonCrawl.value : 0;
  const pageRank = opr.status === 'fulfilled' ? opr.value : null;

  const domainAgeYears = regDate
    ? Math.floor((Date.now() - new Date(regDate).getTime()) / (1000 * 60 * 60 * 24 * 365))
    : null;

  if (!wikipediaPresent) issues.push('No Wikipedia page — low entity authority signal');
  if (!wikidataId) issues.push('No Wikidata entity — reduces LLM training-data inclusion likelihood');
  if (domainAgeYears !== null && domainAgeYears < 2) issues.push(`Domain only ${domainAgeYears} year(s) old — low trust signal`);
  if (backlinkCount < 10) issues.push('Very few external backlinks found in Common Crawl sample');

  return {
    domain_age_years: domainAgeYears,
    wayback_first_seen: waybackDate,
    wikipedia: wikipediaPresent,
    wikidata_id: wikidataId,
    backlink_sample_count: backlinkCount,
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
  // Use OpenSearch API — returns top matching titles
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(brand)}&limit=5&format=json&redirects=resolve`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 6000 });
    if (!res.ok) return false;
    const data = await res.json() as [string, string[], string[], string[]];
    const titles: string[] = data[1] ?? [];
    // Accept if any result title contains the brand name
    return titles.some(t => t.toLowerCase().includes(brand));
  } catch { return false; }
}

async function fetchWikidata(name: string): Promise<string | null> {
  // Use entity search API — much more reliable than exact SPARQL label match
  const brand = brandFromDomain(name);
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(brand)}&language=en&limit=5&format=json`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
    if (!res.ok) return null;
    const data = await res.json() as {
      search?: Array<{ id: string; label?: string; description?: string }>;
    };
    // Prefer an entry whose label matches the brand and description suggests a company/org
    const companyMatch = data.search?.find(e =>
      (e.label ?? '').toLowerCase().includes(brand) &&
      /company|corporation|software|platform|service|organization|business|startup|tech/i.test(e.description ?? '')
    );
    // Fall back to any result whose label starts with the brand
    const looseMatch = data.search?.find(e => (e.label ?? '').toLowerCase().startsWith(brand));
    return (companyMatch ?? looseMatch)?.id ?? null;
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

async function fetchCommonCrawl(domain: string): Promise<number> {
  // Count unique pages from this domain indexed across two CC crawls.
  // `url=*.${domain}` is the CC CDX wildcard that returns all pages under the domain.
  // We count unique full URLs (not just hostnames) to get a real indexed-page count.
  // Two indices → up to 1000 URLs sampled; large sites saturate, small sites give real numbers.
  // 5s timeout per index: if CC CDX doesn't respond in 5s it won't be useful anyway, and
  // keeping it shorter prevents 2×8s = 16s worst-case authority module runtime.
  const indices = ['CC-MAIN-2025-05', 'CC-MAIN-2024-51'];
  const uniquePages = new Set<string>();

  for (const index of indices) {
    try {
      const url = `https://index.commoncrawl.org/${index}-index?url=*.${domain}&output=json&limit=500`;
      const res = await fetchWithTimeout(url, { timeoutMs: 5000 });
      if (!res.ok) continue;
      const text = await res.text();
      for (const line of text.trim().split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { url: string };
          if (parsed.url) uniquePages.add(parsed.url);
        } catch { /* skip malformed line */ }
      }
      // If first index returned good results, stop — avoids double-counting and saves time
      if (uniquePages.size >= 200) break;
    } catch { /* index unavailable — try next */ }
  }

  return uniquePages.size;
}
