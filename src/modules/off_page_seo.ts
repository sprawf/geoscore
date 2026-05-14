import { fetchWithTimeout } from '../lib/http';

export interface OffPageSeoResult {
  score: number;            // 0-100: email security + social presence
  social_profiles: SocialProfile[];
  email_security: EmailSecurity;
  brand_presence: BrandPresence;
  backlink_sources: string[];
  issues: string[];
}

export interface SocialProfile {
  platform: string;
  url: string;
  handle: string;
}

export interface EmailSecurity {
  has_mx: boolean;
  has_spf: boolean;
  has_dmarc: boolean;
  dmarc_policy: string | null;
  spf_record: string | null;
}

export interface BrandPresence {
  ddg_abstract: string | null;
  ddg_entity: string | null;
  has_knowledge_panel: boolean;
}

const SOCIAL_PATTERNS: Array<{ platform: string; regex: RegExp; handle: (m: RegExpMatchArray) => string }> = [
  { platform: 'Twitter / X',  regex: /https?:\/\/(www\.)?(twitter|x)\.com\/((?!intent|share|home|search)[a-zA-Z0-9_]{1,50})\/?/i, handle: m => `@${m[3]}` },
  { platform: 'LinkedIn',     regex: /https?:\/\/(www\.)?linkedin\.com\/(company|in)\/([a-zA-Z0-9_-]{2,80})\/?/i, handle: m => m[3] },
  { platform: 'Facebook',     regex: /https?:\/\/(www\.)?facebook\.com\/(?!sharer|share|dialog|plugins)([a-zA-Z0-9._-]{2,80})\/?/i, handle: m => m[2] },
  { platform: 'Instagram',    regex: /https?:\/\/(www\.)?instagram\.com\/([a-zA-Z0-9._]{1,30})\/?/i, handle: m => `@${m[2]}` },
  { platform: 'YouTube',      regex: /https?:\/\/(www\.)?youtube\.com\/(channel|c|@)\/([a-zA-Z0-9_-]+)\/?/i, handle: m => m[3] },
  { platform: 'TikTok',       regex: /https?:\/\/(www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)\/?/i, handle: m => `@${m[2]}` },
  { platform: 'Pinterest',    regex: /https?:\/\/(www\.)?pinterest\.com\/([a-zA-Z0-9_]+)\/?/i, handle: m => m[2] },
  { platform: 'GitHub',       regex: /https?:\/\/(www\.)?github\.com\/([a-zA-Z0-9_-]+)\/?/i, handle: m => m[2] },
  { platform: 'Threads',      regex: /https?:\/\/(www\.)?threads\.net\/@([a-zA-Z0-9._]+)\/?/i, handle: m => `@${m[2]}` },
];

async function dnsJson(domain: string, type: string): Promise<{ Answer?: Array<{ data: string }> }> {
  try {
    const res = await fetchWithTimeout(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
      { timeoutMs: 5000, headers: { Accept: 'application/dns-json' } }
    );
    return res.ok ? res.json() : {};
  } catch { return {}; }
}

export async function runOffPageSeo(domain: string, html: string): Promise<OffPageSeoResult> {
  const issues: string[] = [];
  const socialSeen = new Set<string>();
  const social_profiles: SocialProfile[] = [];

  // Scan entire HTML text for social URLs — catches href attributes, data-* attributes,
  // inline JS strings, and React/Next.js server-rendered footer content.
  // Using the global flag on each pattern for a full-document scan.
  for (const sp of SOCIAL_PATTERNS) {
    const globalRegex = new RegExp(sp.regex.source, sp.regex.flags.includes('g') ? sp.regex.flags : sp.regex.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = globalRegex.exec(html)) !== null) {
      if (socialSeen.has(sp.platform)) break;
      // Skip URLs that are inside comment blocks or clearly not real links
      const before = html.slice(Math.max(0, m.index - 20), m.index);
      if (/<!--/.test(before) && !/-->/.test(before)) continue; // inside HTML comment
      socialSeen.add(sp.platform);
      social_profiles.push({
        platform: sp.platform,
        url: m[0].replace(/["'>?\s].*$/, ''),
        handle: sp.handle(m),
      });
    }
  }

  if (social_profiles.length === 0) issues.push('No social media profiles found on homepage — social signals matter for GEO and brand authority');
  else if (social_profiles.length < 3) issues.push(`Only ${social_profiles.length} social profile${social_profiles.length > 1 ? 's' : ''} linked — expand social presence for stronger brand signals`);

  // ── Email security via Cloudflare DNS-over-HTTPS ──────────────────────────
  const [mxData, txtData, dmarcData] = await Promise.all([
    dnsJson(domain, 'MX'),
    dnsJson(domain, 'TXT'),
    dnsJson(`_dmarc.${domain}`, 'TXT'),
  ]);

  const has_mx = (mxData.Answer?.length ?? 0) > 0;
  const txtRecords = (txtData.Answer ?? []).map(r => r.data.replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
  const spfRecord = txtRecords.find(r => r.toLowerCase().startsWith('v=spf1')) ?? null;
  const dmarcRecord = (dmarcData.Answer ?? []).map(r => r.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '')).find(r => r.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const has_spf = !!spfRecord;
  const has_dmarc = !!dmarcRecord;
  const dmarcPolicyMatch = dmarcRecord?.match(/p=(none|quarantine|reject)/i);
  const dmarc_policy = dmarcPolicyMatch ? dmarcPolicyMatch[1].toLowerCase() : null;

  if (!has_mx) issues.push('No MX records — domain cannot receive email');
  if (!has_spf) issues.push('No SPF record — email spoofing protection missing');
  if (!has_dmarc) issues.push('No DMARC record — emails can be forged in your domain name');
  else if (dmarc_policy === 'none') issues.push('DMARC policy is "none" (monitor only) — upgrade to "quarantine" or "reject" for real protection');

  const brand_presence: BrandPresence = { ddg_abstract: null, ddg_entity: null, has_knowledge_panel: false };
  const backlink_sources: string[] = [];

  // ── Score computation ─────────────────────────────────────────────────────
  // Email security: max 40 pts
  let score = 0;
  if (has_mx)  score += 10;
  if (has_spf) score += 15;
  if (has_dmarc) score += 10;
  if (dmarc_policy === 'reject' || dmarc_policy === 'quarantine') score += 5;

  // Social presence: max 30 pts
  const socialCount = social_profiles.length;
  if (socialCount >= 3)      score += 30;
  else if (socialCount >= 2) score += 20;
  else if (socialCount >= 1) score += 10;

  // Issue-free bonus: max 30 pts
  const issueCount = issues.length;
  if (issueCount === 0)      score += 30;
  else if (issueCount === 1) score += 20;
  else if (issueCount === 2) score += 10;

  return { score: Math.min(100, score), social_profiles, email_security: { has_mx, has_spf, has_dmarc, dmarc_policy, spf_record: spfRecord }, brand_presence, backlink_sources, issues };
}
