# GeoScore — SEO & AI Visibility Audit Tool

A free, open-source SEO and AI-visibility audit tool that analyses any website in under 60 seconds. Built entirely on **Cloudflare's free tier** (Workers, Pages, D1, KV, Vectorize, Workers AI).

**Live demo → [geoscoreapp.pages.dev](https://geoscoreapp.pages.dev)**

---

## What it audits

| Category | What's checked |
|---|---|
| **Technical SEO** | Crawlability, canonical, hreflang, sitemap, robots.txt, security headers, page weight, render-blocking scripts |
| **On-Page SEO** | Title, meta description, headings, internal links, PageSpeed / Core Web Vitals (mobile + desktop) |
| **Schema Markup** | JSON-LD detection, coverage gaps, e-commerce schema audit |
| **Content Quality** | Word count, readability (Flesch), keyword density, FAQ detection |
| **Off-Page SEO** | Backlink signals, social profile detection, SPF/DMARC/DKIM email security |
| **Domain Authority** | Domain age, Wikipedia/Wikidata presence, backlink sample |
| **AI Visibility (GEO)** | Citation prediction — simulates whether ChatGPT/Claude/Perplexity would cite your site for relevant queries |
| **Keywords** | Opportunity keywords by intent (informational, commercial, transactional) with geo-potential flags |
| **Accessibility** | WCAG 2.1 A/AA checks — alt text, labels, skip links, landmarks, heading hierarchy |
| **Security Audit** | CSP, HSTS, X-Frame-Options, referrer policy, SSL certificate validity |
| **Site Intelligence** | IP, hosting org, CDN, DNS, MX, carbon footprint estimate |
| **Redirect Chain** | Hop count, HTTPS redirect, www/non-www normalisation |

**Computed cards** (assembled from module data):
- SERP snippet preview & character-count warnings
- Social share card (OG/Twitter) with completeness audit
- E-E-A-T scorecard
- Technology stack (Wappalyzer-style)
- Readability score
- Font performance
- DNS & network
- AI Content Insights (business context, trust scores, freshness, opportunities)
- llms.txt generator

---

## Architecture

```
┌──────────────────────┐     SSE stream      ┌──────────────────────┐
│  Cloudflare Pages    │ ◄──────────────────  │  Cloudflare Worker   │
│  (frontend/*)        │                      │  (src/index.ts)      │
│  Static HTML + JS    │  REST + SSE          │                      │
└──────────────────────┘                      │  ┌────────────────┐  │
                                              │  │  D1 (SQLite)   │  │
                                              │  │  KV (cache)    │  │
                                              │  │  Vectorize     │  │
                                              │  │  Workers AI    │  │
                                              │  └────────────────┘  │
                                              └──────────────────────┘
```

Each audit module runs in parallel. Results stream back to the browser via **Server-Sent Events** so the UI fills in card by card as checks complete.

---

## Fork & Deploy in ~10 minutes

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is enough)
- [Node.js](https://nodejs.org/) 18+ (for Wrangler CLI)
- [Git](https://git-scm.com/)

---

### Step 1 — Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/geoscore.git
cd geoscore
npm install
```

---

### Step 2 — Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser window to authorise Wrangler with your Cloudflare account.

---

### Step 3 — Create Cloudflare resources

Run each command and **note the IDs** printed — you'll need them in Step 4.

```bash
# D1 database
npx wrangler d1 create audit-db

# KV namespaces
npx wrangler kv namespace create AUDIT_KV
npx wrangler kv namespace create BUDGET_KV

# Vectorize index (768 dims = Workers AI embedding size)
npx wrangler vectorize create audit-vectors --dimensions=768 --metric=cosine
```

---

### Step 4 — Configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

Open `wrangler.toml` and replace the placeholder values with the IDs from Step 3:

```toml
[[d1_databases]]
database_id = "YOUR_D1_DATABASE_ID"    # ← paste here

[[kv_namespaces]]
binding = "AUDIT_KV"
id = "YOUR_AUDIT_KV_ID"               # ← paste here

[[kv_namespaces]]
binding = "BUDGET_KV"
id = "YOUR_BUDGET_KV_ID"              # ← paste here
```

Also update the `NOMINATIM_USER_AGENT` variable with your own contact info (required by OpenStreetMap's terms of use):

```toml
[vars]
NOMINATIM_USER_AGENT = "YourAppName/1.0 (you@yourdomain.com)"
```

> **Note:** `wrangler.toml` is in `.gitignore` so your IDs are never committed. Only `wrangler.toml.example` is tracked.

---

### Step 5 — Apply database migrations

```bash
# Local development
npm run db:migrate:local

# Remote (production)
npm run db:migrate
```

---

### Step 6 — Point the frontend at your Worker

Open `frontend/app.js` and update line 1:

```javascript
// Change this:
const API = 'https://audit-api.sprawf.workers.dev';

// To your Worker's URL (you get this after deploying in Step 7):
const API = 'https://audit-api.YOUR_SUBDOMAIN.workers.dev';
```

> **Tip:** Your Cloudflare subdomain is shown at `dash.cloudflare.com → Workers & Pages → Overview`.

---

### Step 7 — Deploy

```bash
# Deploy the Worker (backend)
npm run deploy

# Deploy the frontend to Cloudflare Pages
npm run deploy:pages
```

The first `deploy:pages` run will prompt you to create a new Pages project — just accept the defaults.

Your audit tool is now live at `https://audit-api.YOUR_SUBDOMAIN.workers.dev` (API) and the URL printed by the Pages deploy command (frontend).

---

### Step 8 (optional) — Local development

```bash
npm run dev
```

This starts a local Wrangler dev server at `http://127.0.0.1:8787`. The frontend at `frontend/index.html` can be opened directly in a browser — it will talk to your local Worker.

---

## Optional features

### Email alerts (weekly score monitoring)

The tool has a built-in monitoring system that re-audits subscribed domains weekly and emails if the score changes ≥5 points. It uses [Resend](https://resend.com) (free tier: 3,000 emails/month).

1. Sign up at [resend.com](https://resend.com) and get an API key
2. Add it as a secret (never put it in `wrangler.toml`):

```bash
npx wrangler secret put RESEND_API_KEY
```

### SearXNG (fallback search)

For keyword research, the tool optionally calls a [SearXNG](https://searxng.org/) instance. Set the URL in `wrangler.toml`:

```toml
SEARXNG_URL = "https://your-searxng-instance.com"
```

Leave it empty to skip (keyword module uses Workers AI fallback instead).

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `NOMINATIM_USER_AGENT` | Yes | Your app name + contact email for OpenStreetMap geocoding API |
| `SEARXNG_URL` | No | URL of a SearXNG search instance |
| `DAILY_BROWSER_BUDGET_SECONDS` | No | Max seconds/day for browser-based checks (default: 540) |
| `RESEND_API_KEY` | No | Resend API key for weekly monitoring alert emails |

---

## Project structure

```
geoscore/
├── frontend/               # Static site (Cloudflare Pages)
│   ├── index.html          # Single-page app shell
│   ├── app.js              # All UI logic (~3 700 lines)
│   ├── print.css           # Print stylesheet
│   ├── _headers            # Cloudflare Pages HTTP headers
│   └── _redirects          # Cloudflare Pages redirects
│
├── src/
│   ├── index.ts            # Worker entry point & router
│   ├── lib/
│   │   ├── bot-detection.ts  # WAF/CAPTCHA page detection
│   │   ├── cache.ts          # KV audit caching
│   │   ├── http.ts           # Fetch with timeout helper
│   │   ├── llm.ts            # Workers AI wrapper
│   │   ├── rate-limit.ts     # Per-IP rate limiting via KV
│   │   ├── sse.ts            # Server-Sent Events helpers
│   │   └── types.ts          # Shared TypeScript types (Env, etc.)
│   │
│   ├── modules/            # One file per audit module
│   │   ├── accessibility.ts
│   │   ├── ai_content_insights.ts
│   │   ├── authority.ts
│   │   ├── content_quality.ts
│   │   ├── crux.ts           # Chrome UX Report (CrUX) API
│   │   ├── domain_intel.ts
│   │   ├── geo_predicted.ts  # AI citation prediction
│   │   ├── keywords.ts
│   │   ├── off_page_seo.ts
│   │   ├── on_page_seo.ts
│   │   ├── recommendations.ts
│   │   ├── redirect_chain.ts
│   │   ├── resolver.ts
│   │   ├── schema_audit.ts
│   │   ├── security_audit.ts
│   │   ├── site_intel.ts
│   │   ├── ssl_cert.ts
│   │   └── technical_seo.ts
│   │
│   ├── prompts/            # AI prompt templates
│   │
│   └── routes/             # HTTP route handlers
│       ├── audit.ts        # Main audit orchestrator (SSE streaming)
│       ├── businesses.ts
│       ├── chat.ts         # AI chat about audit results
│       ├── feedback.ts     # User corrections + learning
│       ├── fix.ts          # AI-generated fix guides
│       ├── history.ts      # Score history per domain
│       ├── llms_gen.ts     # llms.txt generator
│       └── search.ts       # Domain search
│
├── migrations/             # D1 SQL schema migrations
│   ├── 0001_init.sql
│   ├── 0002_seed_uae.sql
│   └── 0003_learning.sql
│
├── wrangler.toml.example   # Config template (copy → wrangler.toml)
├── tsconfig.json
└── package.json
```

---

## Cloudflare free tier limits

This project is designed to run comfortably within Cloudflare's free tier:

| Resource | Free limit | Typical usage |
|---|---|---|
| Workers requests | 100,000/day | ~1 request per audit |
| Workers CPU time | 10ms per request | Each module is async I/O, minimal CPU |
| D1 reads | 5M/day | ~50 reads per audit |
| D1 writes | 100K/day | ~5 writes per audit |
| KV reads | 100K/day | 1–2 reads per audit (cache check) |
| KV writes | 1,000/day | 1 write per audit (cache store) |
| Workers AI | ~10K neurons/day | Used for keyword + GEO + AI insights modules |
| Pages builds | 500/month | 1 per frontend deploy |

For high-traffic use, the AI modules (geo_predicted, keywords, ai_content_insights) are the first to hit limits. They fall back gracefully when quota is exceeded.

---

## Contributing

Pull requests welcome. Each module is isolated in `src/modules/` — adding a new audit check means creating a new file and wiring it in `src/routes/audit.ts`.

---

## License

MIT — do whatever you want with it. Attribution appreciated but not required.
