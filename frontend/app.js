const API = 'https://audit-api.sprawf.workers.dev';  // direct Worker — bypasses Pages proxy SSE buffering
let currentAuditId = null;
let currentDomain = '';
const recMap = new Map(); // index → rec object, rebuilt on each audit

// ── "How it works?" modal ─────────────────────────────────────────────────
const hiwModal  = document.getElementById('hiw-modal');
const hiwClose  = document.getElementById('hiw-close');

if (hiwClose) hiwClose.addEventListener('click', () => hiwModal?.classList.add('hidden'));
hiwModal.addEventListener('click', (e) => { if (e.target === hiwModal) hiwModal.classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hiwModal.classList.add('hidden'); });

document.querySelectorAll('.hiw-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.hiw-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.hiw-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── URL parameter auto-start (?d=stripe.com or ?domain=stripe.com) ────────
(function () {
  const params = new URLSearchParams(location.search);
  const d = params.get('d') || params.get('domain');
  if (d) { window.addEventListener('DOMContentLoaded', () => {}, { once: true }); startAudit(d); }
})();

// ── Social proof: fetch audit count + recently scanned feed ──────────────
(function () {
  const el = document.getElementById('audits-count');
  fetch(`${API}/api/stats`).then(r => r.json()).then(({ audits }) => {
    if (el && audits) {
      const formatted = audits >= 1000 ? (audits / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : audits;
      el.textContent = `${formatted}+ sites audited`;
    }
  }).catch(() => {});

})();

// ── Progress counter ──────────────────────────────────────────────────────
const PROGRESS_MODULES = new Set([
  'technical_seo','schema_audit','content_quality','authority','geo_predicted',
  'keywords','on_page_seo','off_page_seo','site_intel',
  'redirect_chain','accessibility','security_audit','ssl_cert',
  'domain_intel','crux',
]);
const TOTAL_MODULES = PROGRESS_MODULES.size;
let modulesComplete = 0;
let computedSectionsRendered = false;
let auditStartTime = 0;
let auditTimerInterval = null;

const MODULE_CATEGORY = {
  technical_seo: 'seo', schema_audit: 'seo', content_quality: 'seo',
  on_page_seo: 'seo', accessibility: 'seo',
  geo_predicted: 'geo', ai_content_insights: 'geo',
  security_audit: 'seo', ssl_cert: 'seo',
  authority: 'authority', off_page_seo: 'authority',
  site_intel: 'site_intel', redirect_chain: 'site_intel',
  domain_intel: 'seo', crux: 'seo',
};

// Display order: GEO/AI visibility first → Authority → Content → Technical → Site details → Action
const CARD_ORDER = {
  // 1. GEO & AI visibility — the core value prop
  'module-geo_predicted':       10,
  'card-ai-business':           12,
  'card-ai-content':            13,
  'card-ai-trust':              14,
  'card-ai-freshness':          15,
  'card-ai-opportunities':      16,
  'card-eeat':                  20,
  'card-llms-gen':              25,
  'card-keyword-research':      30,
  // 2. Authority & trust — feeds GEO signals
  'module-authority':           40,
  'module-off_page_seo':        50,
  // 3. Content & schema — what AI reads
  'module-schema_audit':        60,
  'card-structured-data':       62,
  'module-content_quality':     70,
  'module-on_page_seo':         80,
  'card-readability':           82,
  'card-serp-preview':          85,
  'card-international-seo':     87,
  'card-social-preview':        89,
  // 4. Technical foundation
  'module-technical_seo':      100,
  'module-ssl_cert':           108,
  'module-redirect_chain':     112,
  'module-security_audit':     116,
  'module-domain_intel':       120,
  'module-crux':               124,
  'module-accessibility':      128,
  // 5. Site details — least critical
  'module-site_intel':         140,
  'card-tech-stack':           142,
  'card-dns':                  144,
  'card-fonts':                146,
  'card-headings':             148,
  'card-image-alt':            149,
  'card-speed':                150,
  'card-mobile':               151,
  'card-email-ads':            152,
  'card-robots':               153,
  'module-ai_content_insights': 154,
  // 6. Action
  'card-keywords-cloud':       160,
  'card-competitor':           163,
  'recs-section':              170,
  'card-embed-code':           180,
};
function cardOrder(id) { return CARD_ORDER[id] ?? 500; }

function scoreContext(score) {
  if (score >= 85) return 'Top 15% of sites';
  if (score >= 70) return 'Above average';
  if (score >= 55) return 'Average range';
  if (score >= 40) return 'Below average';
  return 'Needs improvement';
}

function effortTime(effort) {
  return ['', '⚡ ~15 min', '🕐 ~30 min', '🕑 1–2 hrs', '📅 Half day', '📅 Multi-day'][effort] ?? '';
}

function fmtSecs(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function initProgress() {
  modulesComplete = 0;
  auditStartTime = Date.now();
  const bar = document.getElementById('progress-bar');
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  const timer = document.getElementById('audit-timer');
  if (bar) bar.classList.remove('hidden');
  if (fill) fill.style.width = '0%';
  if (label) label.textContent = `0 / ${TOTAL_MODULES} modules`;
  if (timer) timer.textContent = '0s';

  // Clear any previous timer before starting a new one
  if (auditTimerInterval) clearInterval(auditTimerInterval);
  auditTimerInterval = setInterval(() => {
    const elapsed = Date.now() - auditStartTime;
    const timerEl = document.getElementById('audit-timer');
    if (timerEl) timerEl.textContent = fmtSecs(elapsed);

    // Update each running module's live elapsed display
    document.querySelectorAll('.module-elapsed').forEach(el => {
      const startMs = Number(el.dataset.startMs);
      if (startMs) el.textContent = fmtSecs(Date.now() - startMs);
    });
  }, 1000);
}

function stopAuditTimer() {
  if (auditTimerInterval) { clearInterval(auditTimerInterval); auditTimerInterval = null; }
}

function tickProgress() {
  modulesComplete = Math.min(modulesComplete + 1, TOTAL_MODULES);
  const pct = Math.round((modulesComplete / TOTAL_MODULES) * 100);
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${modulesComplete} / ${TOTAL_MODULES} modules`;
  if (modulesComplete >= TOTAL_MODULES) {
    stopAuditTimer();
    setTimeout(() => { const bar = document.getElementById('progress-bar'); if (bar) bar.classList.add('hidden'); }, 1200);
  }
}
let sessionId = localStorage.getItem('session_id') || crypto.randomUUID();
localStorage.setItem('session_id', sessionId);

// ── Semantic Search (Transformers.js v3 + WebGPU) ─────────────────────────
// BGE-Small-EN-v1.5 ONNX (33 MB) runs on WebGPU via ONNX Runtime Web.
// Same model family as @cf/baai/bge-small-en-v1.5 in Workers AI — vector
// spaces are compatible, so embeddings can be compared cross-environment.
// Swap SEMANTIC_MODEL to 'onnx-community/Ternary-Bonsai-1.7B' once that
// ONNX conversion is published on HuggingFace Hub (not yet available).

const SEMANTIC_MODEL = 'Xenova/bge-small-en-v1.5';
const SEM_IDB = 'geo_audit_sem';
const SEM_STORE = 'vecs';

let embedder = null;
let allBusinesses = [];
let businessVecs = null;  // Float32Array[] parallel to allBusinesses
let semanticReady = false;

// BGE normalises vectors to unit length, so dot product = cosine similarity
function dotSim(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function idbOp(mode, key, val) {
  return new Promise((resolve) => {
    const req = indexedDB.open(SEM_IDB, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(SEM_STORE);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(SEM_STORE, mode);
      const r = mode === 'readonly'
        ? tx.objectStore(SEM_STORE).get(key)
        : tx.objectStore(SEM_STORE).put(val, key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

async function embedBatch(texts) {
  const out = await embedder(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return Array.from({ length: texts.length }, (_, i) =>
    new Float32Array(out.data.slice(i * dim, (i + 1) * dim))
  );
}

async function initSemanticSearch() {
  if (!navigator.gpu) return;
  try {
    setSemanticBadge('loading');

    const { pipeline, env } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js'
    );
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    embedder = await pipeline('feature-extraction', SEMANTIC_MODEL, {
      device: 'webgpu',
      dtype: 'q8',
    });

    const r = await fetch(`${API}/api/businesses`);
    allBusinesses = r.ok ? await r.json() : [];
    if (!allBusinesses.length) { setSemanticBadge('off'); return; }

    // Restore pre-computed business embeddings from IndexedDB if available
    const cacheKey = `${SEMANTIC_MODEL}@${allBusinesses.length}`;
    const hit = await idbOp('readonly', cacheKey);
    if (hit) {
      businessVecs = hit.map(arr => new Float32Array(arr));
    } else {
      // Embed all businesses in batches of 16 (background, non-blocking for UI)
      const texts = allBusinesses.map(
        b => `${b.name} ${b.category || ''} ${b.city || ''}`.replace(/\s+/g, ' ').trim()
      );
      businessVecs = [];
      for (let i = 0; i < texts.length; i += 16) {
        businessVecs.push(...await embedBatch(texts.slice(i, i + 16)));
      }
      // Persist — serialise Float32Arrays to plain arrays for structured clone
      idbOp('readwrite', cacheKey, businessVecs.map(v => Array.from(v)));
    }

    semanticReady = true;
    setSemanticBadge('ready');
  } catch (err) {
    console.warn('[semantic]', err?.message ?? err);
    setSemanticBadge('off');
  }
}

function setSemanticBadge(state) {
  const el = document.getElementById('semantic-badge');
  if (!el) return;
  el.className = 'text-xs px-2 py-0.5 rounded';
  if (state === 'loading') {
    el.textContent = '⚡ AI loading…';
    el.classList.add('bg-amber-50', 'text-amber-600');
  } else if (state === 'ready') {
    el.textContent = '⚡ AI search';
    el.classList.add('bg-green-50', 'text-green-700', 'font-medium');
  } else {
    el.textContent = '';
  }
}

async function semanticSearch(q, topK = 8) {
  if (!semanticReady || !embedder || !businessVecs) return null;
  try {
    const out = await embedder(q, { pooling: 'mean', normalize: true });
    const qvec = new Float32Array(out.data);
    const scored = allBusinesses.map((b, i) => ({ ...b, _sim: dotSim(qvec, businessVecs[i]) }));
    scored.sort((a, b) => b._sim - a._sim);
    return scored.filter(b => b._sim > 0.25).slice(0, topK);
  } catch {
    return null;
  }
}

// Kick off model loading in background — doesn't block page render
initSemanticSearch();
// Show recent audit history on page load
renderRecentAudits();

// ── Scroll-to-top ──────────────────────────────────────────────────────────
{
  const scrollTopBtn = document.getElementById('scroll-top');
  if (scrollTopBtn) {
    window.addEventListener('scroll', () => {
      const show = window.scrollY > 400;
      if (show) { scrollTopBtn.classList.remove('hidden'); scrollTopBtn.classList.add('flex'); }
      else       { scrollTopBtn.classList.add('hidden');   scrollTopBtn.classList.remove('flex'); }
    }, { passive: true });
    scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }
}

// ── Collapsible card toggle ────────────────────────────────────────────────
// rotated = card collapsed (chevron points up, body hidden)
function toggleCardBody(headerEl) {
  const body = headerEl.parentElement.querySelector('.card-body');
  if (!body) return;
  const isNowHidden = body.classList.toggle('hidden');
  headerEl.querySelector('.chevron')?.classList.toggle('rotated', isNowHidden);
}

// ── Recent audits ──────────────────────────────────────────────────────────
function saveRecentAudit(domain) {
  try {
    const key = 'geoscore:recent';
    let recent = JSON.parse(localStorage.getItem(key) || '[]');
    recent = recent.filter(d => d !== domain);
    recent.unshift(domain);
    localStorage.setItem(key, JSON.stringify(recent.slice(0, 5)));
  } catch { /* non-critical */ }
}

function renderRecentAudits() {
  try {
    const wrap = document.getElementById('recent-audits-wrap');
    if (!wrap) return;
    const recent = JSON.parse(localStorage.getItem('geoscore:recent') || '[]');
    if (!recent.length) { wrap.classList.add('hidden'); return; }
    wrap.innerHTML = `<div class="flex items-center gap-2 flex-wrap justify-center">
      <span class="text-xs text-slate-400 shrink-0">Recent:</span>
      ${recent.map(d => `<button data-quick="${esc(d)}"
        class="inline-flex items-center gap-1.5 text-xs bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-600 px-2.5 py-1 rounded-full transition-colors font-medium text-slate-600 shadow-sm">
        <img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(d)}" alt="" class="w-3.5 h-3.5 rounded-sm" onerror="this.style.display='none'">
        ${esc(d)}
      </button>`).join('')}
    </div>`;
    wrap.classList.remove('hidden');
  } catch { /* non-critical */ }
}

// ── Category tab counts ────────────────────────────────────────────────────
// Store original labels on first call so counts can be reset
const _catTabOriginalLabels = new Map();
function updateCatTabCounts() {
  // Initialise label cache once
  document.querySelectorAll('.cat-tab').forEach(tab => {
    if (!_catTabOriginalLabels.has(tab.dataset.cat)) {
      _catTabOriginalLabels.set(tab.dataset.cat, tab.textContent.trim());
    }
  });
  // Count visible cards per category
  const counts = {};
  document.querySelectorAll('#modules > [data-category]').forEach(el => {
    if (el.style.display === 'none') return;
    const cat = el.dataset.category;
    if (cat) counts[cat] = (counts[cat] || 0) + 1;
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  document.querySelectorAll('.cat-tab').forEach(tab => {
    const cat = tab.dataset.cat;
    const label = _catTabOriginalLabels.get(cat) || tab.textContent.replace(/\s*\(\d+\)\s*$/, '');
    const count = cat === 'all' ? total : (counts[cat] || 0);
    tab.textContent = count > 0 ? `${label} (${count})` : label;
  });
}

// ── Rec checkbox: mark as done ─────────────────────────────────────────────
function getRecDoneSet(domain) {
  try { return new Set(JSON.parse(localStorage.getItem(`geoscore:rec-done:${domain}`) || '[]')); }
  catch { return new Set(); }
}
function saveRecDoneSet(domain, set) {
  try { localStorage.setItem(`geoscore:rec-done:${domain}`, JSON.stringify([...set])); } catch { }
}

document.addEventListener('change', (e) => {
  const cb = e.target.closest('.rec-checkbox');
  if (!cb) return;
  const li = cb.closest('li');
  const done = getRecDoneSet(currentDomain);
  const title = cb.dataset.title;
  if (cb.checked) {
    done.add(title);
    li?.classList.add('rec-done');
  } else {
    done.delete(title);
    li?.classList.remove('rec-done');
  }
  saveRecDoneSet(currentDomain, done);
});

// OG image load-error fallback (capture phase — works without inline onerror)
document.addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG' || !e.target.classList.contains('og-preview-img')) return;
  const wrapper = e.target.parentElement;
  if (wrapper) wrapper.innerHTML = '<div class="h-full min-h-[8rem] flex items-center justify-center bg-slate-100 text-slate-400 text-xs p-2">Image could not be loaded</div>';
}, true);

// ── Category tabs ─────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.cat-tab');
  if (!tab) return;
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  const cat = tab.dataset.cat;
  document.querySelectorAll('#modules > [data-category]').forEach(el => {
    el.style.display = (cat === 'all' || el.dataset.category === cat) ? '' : 'none';
  });
  // Recommendations always visible
  const recs = document.getElementById('recs-section');
  if (recs) recs.style.display = '';
});

// ── Quick-search shortcuts ────────────────────────────────────────────────

function quickSearch(domain) {
  searchInput.value = domain;
  suggestions.classList.add('hidden');
  startAudit(domain);
}

document.addEventListener('click', (e) => {
  const quick = e.target.closest('[data-quick]');
  if (quick) { quickSearch(quick.dataset.quick); return; }

  const fix = e.target.closest('[data-action="toggle-fix"]');
  if (fix) { toggleWhatToDo(fix); return; }

  // llms.txt generator
  if (e.target.id === 'llms-gen-btn') {
    handleLlmsGen(e.target);
    return;
  }
  if (e.target.id === 'llms-copy-btn') {
    const text = document.getElementById('llms-gen-text')?.textContent ?? '';
    navigator.clipboard.writeText(text).then(() => {
      e.target.textContent = '✓ Copied!';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
    });
    return;
  }
  if (e.target.id === 'llms-view-btn') {
    handleLlmsView(e.target);
    return;
  }
});

async function handleLlmsGen(btn) {
  const output = document.getElementById('llms-gen-output');
  const textEl = document.getElementById('llms-gen-text');
  const copyBtn = document.getElementById('llms-copy-btn');
  if (!output || !textEl) return;

  btn.disabled = true;
  output.classList.remove('hidden');
  textEl.textContent = '';

  const genStart = Date.now();
  const genTimer = setInterval(() => {
    btn.textContent = `⏳ Generating… ${fmtSecs(Date.now() - genStart)}`;
  }, 1000);
  btn.textContent = '⏳ Generating… 0s';

  try {
    const res = await fetch(`${API}/api/llms-gen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: btn.dataset.domain,
        vertical: btn.dataset.vertical,
        keywords: (btn.dataset.keywords || '').split(',').filter(Boolean),
        schemas: (btn.dataset.schemas || '').split(',').filter(Boolean),
      }),
    });

    if (!res.ok || !res.body) throw new Error('Generation failed');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try { raw += JSON.parse(payload).response ?? ''; } catch { /* skip */ }
      }
      textEl.textContent = raw;
      output.querySelector('pre').scrollTop = 9999;
    }

    clearInterval(genTimer);
    if (copyBtn) copyBtn.classList.remove('hidden');
    btn.textContent = `↻ Re-generate (took ${fmtSecs(Date.now() - genStart)})`;
  } catch {
    clearInterval(genTimer);
    textEl.textContent = 'Generation failed — AI may be unavailable. Try again.';
    btn.textContent = '✨ Generate llms.txt';
  } finally {
    btn.disabled = false;
  }
}

async function handleLlmsView(btn) {
  const output = document.getElementById('llms-gen-output');
  const textEl = document.getElementById('llms-gen-text');
  const copyBtn = document.getElementById('llms-copy-btn');
  if (!output || !textEl) return;

  // Toggle: if already showing fetched content, hide it
  if (btn.dataset.showing === '1') {
    output.classList.add('hidden');
    if (copyBtn) copyBtn.classList.add('hidden');
    btn.dataset.showing = '0';
    btn.textContent = '👁 View existing';
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Loading…';
  output.classList.remove('hidden');
  textEl.textContent = 'Fetching llms.txt…';

  try {
    const res = await fetch(`${API}/api/fetch-llms?domain=${encodeURIComponent(btn.dataset.domain)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const text = await res.text();
    textEl.textContent = text;
    if (copyBtn) copyBtn.classList.remove('hidden');
    btn.dataset.showing = '1';
    btn.textContent = '✕ Hide';
  } catch (err) {
    textEl.textContent = `Could not fetch llms.txt: ${err.message}`;
    btn.dataset.showing = '0';
    btn.textContent = '👁 View existing';
  } finally {
    btn.disabled = false;
  }
}

// ── Search & Autocomplete ──────────────────────────────────────────────────

const searchInput = document.getElementById('search-input');
const suggestions = document.getElementById('suggestions');
let debounce;

searchInput.addEventListener('input', () => {
  clearTimeout(debounce);
  const q = searchInput.value.trim();
  if (q.length < 2) { suggestions.classList.add('hidden'); return; }
  debounce = setTimeout(() => fetchSuggestions(q), 250);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = searchInput.value.trim();
    if (q) { suggestions.classList.add('hidden'); startAudit(q); }
  }
});

document.getElementById('audit-btn')?.addEventListener('click', () => {
  const q = searchInput.value.trim();
  if (q) { suggestions.classList.add('hidden'); startAudit(q); }
});

document.addEventListener('click', (e) => {
  if (!suggestions.contains(e.target)) suggestions.classList.add('hidden');
});

async function fetchSuggestions(q) {
  try {
    const [kwResults, semResults] = await Promise.all([
      fetch(`${API}/api/search?q=${encodeURIComponent(q)}`)
        .then(r => r.ok ? r.json() : [])
        .catch(() => []),
      semanticSearch(q),
    ]);

    if (semResults?.length) {
      // Semantic results first; backfill with keyword extras not already present
      const seen = new Set(semResults.map(b => b.domain || b.name));
      const extras = (kwResults || []).filter(b => !seen.has(b.domain || b.name));
      renderSuggestions([...semResults, ...extras].slice(0, 8));
    } else {
      renderSuggestions(kwResults || []);
    }
  } catch { suggestions.classList.add('hidden'); }
}

const CATEGORY_LABELS = {
  dental: '🦷 Dental', hotel: '🏨 Hotel', restaurant: '🍽️ Restaurant',
  fitness: '💪 Fitness', legal: '⚖️ Legal', real_estate: '🏠 Real Estate',
  medical: '🏥 Medical', ecommerce: '🛒 E-commerce', tech: '💻 Tech',
  airline: '✈️ Airline', telecom: '📡 Telecom', tourism: '🗺️ Tourism',
};

function renderSuggestions(items) {
  if (!items.length) { suggestions.classList.add('hidden'); return; }
  suggestions.innerHTML = items.map((b) => {
    const catLabel = CATEGORY_LABELS[b.category] || (b.category ? esc(b.category) : '');
    return `
    <li class="px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0"
        data-domain="${b.domain || ''}" data-name="${esc(b.name)}">
      <div class="flex items-center justify-between">
        <div class="font-medium text-sm">${esc(b.name)}</div>
        ${catLabel ? `<span class="text-xs text-slate-400 ml-2 shrink-0">${catLabel}</span>` : ''}
      </div>
      <div class="text-xs text-slate-400 mt-0.5">${esc(b.city || '')}${b.city && b.domain ? ' · ' : ''}${esc(b.domain || '')}</div>
    </li>`;
  }).join('');
  suggestions.classList.remove('hidden');
  suggestions.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      const domain = li.dataset.domain || li.dataset.name;
      searchInput.value = domain;
      suggestions.classList.add('hidden');
      startAudit(domain);
    });
  });
}

// ── Audit ──────────────────────────────────────────────────────────────────

function looksLikeDomain(str) {
  return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(str);
}

// Build smart domain guesses from free-text input
function buildDomainGuesses(input) {
  const q = input.toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9\s.\-]/g, '').trim();
  const guesses = [];

  // TLD transposition fixes (e.g. stripe.cmo → stripe.com)
  const tldFixes = { '.cmo': '.com', '.ocm': '.com', '.con': '.com', '.ner': '.net', '.rog': '.org' };
  for (const [bad, good] of Object.entries(tldFixes)) {
    if (q.endsWith(bad) && q.length > bad.length) {
      guesses.push(q.slice(0, -bad.length) + good);
    }
  }

  if (!q.includes('.')) {
    const words = q.split(/\s+/).filter(Boolean);
    const first = words[0];
    if (first && first.length >= 2) {
      guesses.push(`${first}.com`);
      const joined = words.join('');
      if (joined !== first && joined.length >= 3 && joined.length <= 24) {
        guesses.push(`${joined}.com`);
      }
      if (first.length >= 3) guesses.push(`${first}.co.uk`);
    }
  }

  // Deduplicate, keep valid-looking ones only
  return [...new Set(guesses)].filter(d => looksLikeDomain(d)).slice(0, 4);
}

async function startAudit(rawInput) {
  let domain = rawInput.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').trim().toLowerCase();
  if (!domain) return;

  if (!looksLikeDomain(domain)) {
    showAuditShell(domain);
    const card = document.getElementById('business-card');
    card.innerHTML = `<div class="text-sm text-slate-400 italic">Searching…</div>`;

    // Parallel: generate guesses + search DB
    const [domainGuesses, dbResults] = await Promise.all([
      Promise.resolve(buildDomainGuesses(domain)),
      fetch(`${API}/api/search?q=${encodeURIComponent(domain)}`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);

    // Merge: domain guesses first, then DB business matches (deduped)
    const seenDomains = new Set(domainGuesses);
    const dbSuggestions = (dbResults || [])
      .filter(b => b.domain && !seenDomains.has(b.domain))
      .slice(0, 3)
      .map(b => ({ domain: b.domain, label: b.name }));

    const allSuggestions = [
      ...domainGuesses.map(d => ({ domain: d, label: d })),
      ...dbSuggestions,
    ];

    currentDomain = domain;

    if (allSuggestions.length > 0) {
      card.innerHTML = `
        <div class="flex items-center gap-2 mb-3">
          <span class="text-slate-400 text-sm">Did you mean?</span>
        </div>
        <div class="flex flex-wrap gap-2">
          ${allSuggestions.map(s => `
            <button class="flex items-center gap-2 border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 px-3 py-2 rounded-xl text-sm font-medium transition-colors" data-quick="${esc(s.domain)}">
              <svg class="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              ${esc(s.label !== s.domain ? s.label + ' · ' : '')}${esc(s.domain)}
            </button>`).join('')}
        </div>
        <div class="text-xs text-slate-400 mt-3">Or type a full domain like <span class="font-mono text-slate-500">stripe.com</span> and press Enter</div>`;
    } else {
      card.innerHTML = `
        <div class="text-sm text-slate-700 mb-2">No matches found for <strong class="text-slate-900">${esc(rawInput)}</strong></div>
        <div class="text-xs text-slate-500">Enter a website domain (e.g. <span class="font-mono">stripe.com</span>, <span class="font-mono">dentist-london.co.uk</span>)</div>`;
    }
    return;
  }

  currentDomain = domain;
  history.pushState({}, '', '?d=' + encodeURIComponent(domain));
  showAuditShell(domain);
  document.getElementById('business-card').innerHTML = spinnerCard(domain);
  openAuditStream(domain, 0);
}

function showAuditShell(domain) {
  stopAuditTimer();
  document.getElementById('audit').classList.remove('hidden');
  document.getElementById('scores').classList.add('hidden');
  document.getElementById('embed-cta').classList.add('hidden');
  document.getElementById('chat-section').classList.add('hidden');
  document.getElementById('cwv-row').classList.add('hidden');
  const msgs = document.getElementById('chat-messages');
  if (msgs) { msgs.innerHTML = ''; msgs.style.maxHeight = '0'; }
  const clearBtn = document.getElementById('chat-clear');
  if (clearBtn) { clearBtn.classList.add('hidden'); clearBtn.classList.remove('flex'); }
  const sugg = document.getElementById('chat-suggestions');
  if (sugg) sugg.classList.remove('hidden');
  const main = document.getElementById('main-content');
  if (main) main.style.paddingBottom = '';
  document.getElementById('modules').innerHTML = '';
  computedSectionsRendered = false;
  const summaryBar = document.getElementById('summary-bar');
  if (summaryBar) { summaryBar.innerHTML = ''; summaryBar.classList.add('hidden'); }
  const ctxEl = document.getElementById('overall-context');
  if (ctxEl) ctxEl.textContent = '';
  const deltaEl = document.getElementById('overall-delta');
  if (deltaEl) { deltaEl.textContent = ''; deltaEl.classList.add('hidden'); }
  // Reset grade badges
  ['overall','seo','geo','perf'].forEach(k => {
    const g = document.getElementById(`${k}-grade`);
    if (g) { g.textContent = '—'; g.className = 'mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full inline-block grade-b'; }
    const s = document.getElementById(`${k}-score`);
    if (s) s.textContent = '—';
    // Reset rings to empty — MUST also reset display in case a prior audit hid the
    // ring via the "No data" path; otherwise the next audit's animateRing call
    // animates an invisible element and the arc never appears.
    const r = document.getElementById(`ring-${k}`);
    if (r) { r.style.strokeDashoffset = '314.16'; r.style.display = ''; }
  });
  // Reset performance block visibility — if a prior audit hid it (no CrUX data)
  // the next audit must start with it visible again.
  const perfWrap = document.getElementById('perf-circle-wrap');
  if (perfWrap) perfWrap.style.display = '';
  const perfSub = document.getElementById('perf-score-sub');
  if (perfSub) perfSub.textContent = '/100';
  // Reset monitor panel
  ['monitor-banner'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.maxHeight = '0'; el.style.opacity = '0'; }
  });
  const catTabs = document.getElementById('cat-tabs');
  if (catTabs) catTabs.classList.remove('hidden');
  document.querySelectorAll('.cat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.cat === 'all');
    // Reset count suffix from previous audit
    const orig = _catTabOriginalLabels.get(t.dataset.cat);
    if (orig) t.textContent = orig;
  });
  recMap.clear();
  initProgress();
}

// Apply the currently active category filter to a freshly-appended card
function applyActiveCatFilter(el) {
  const activeCat = document.querySelector('.cat-tab.active')?.dataset.cat;
  if (activeCat && activeCat !== 'all' && el.dataset.category !== activeCat) {
    el.style.display = 'none';
  }
}

function spinnerCard(domain) {
  // Populate the new header elements
  const nameEl = document.getElementById('domain-name');
  const dateEl = document.getElementById('audit-date');
  const faviconEl = document.getElementById('domain-favicon');
  if (nameEl) nameEl.textContent = domain;
  if (dateEl) dateEl.textContent = 'Auditing — this takes about 60 seconds…';
  if (faviconEl) {
    faviconEl.innerHTML = `<img src="https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(domain)}" alt="" class="w-6 h-6" onerror="this.style.display='none'">`;
  }
  return ''; // business-card inner HTML is now in the header elements
}

// ── Score ring helpers ────────────────────────────────────────────────────────
function gradeLabel(score) {
  if (score >= 90) return { text: 'A+', cls: 'grade-a' };
  if (score >= 80) return { text: 'A',  cls: 'grade-a' };
  if (score >= 70) return { text: 'B+', cls: 'grade-b' };
  if (score >= 60) return { text: 'B',  cls: 'grade-b' };
  if (score >= 50) return { text: 'C+', cls: 'grade-c' };
  if (score >= 40) return { text: 'C',  cls: 'grade-c' };
  if (score >= 30) return { text: 'D',  cls: 'grade-d' };
  return { text: 'F', cls: 'grade-f' };
}

function animateRing(ringId, score, color) {
  const ring = document.getElementById(ringId);
  if (!ring) return;
  ring.style.display = ''; // ensure visible — may have been hidden by a prior "No data" state
  const circumference = 314.16;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  ring.style.stroke = color;
  // Trigger reflow then animate
  requestAnimationFrame(() => {
    ring.style.transition = 'stroke-dashoffset 0.9s cubic-bezier(0.4,0,0.2,1)';
    ring.style.strokeDashoffset = offset;
  });
}

function setScoreCircle(key, score, color) {
  const scoreEl = document.getElementById(`${key}-score`);
  const gradeEl = document.getElementById(`${key}-grade`);
  const ringId = `ring-${key}`;

  if (scoreEl) scoreEl.textContent = score;
  if (gradeEl) {
    const g = gradeLabel(score);
    gradeEl.textContent = g.text;
    gradeEl.className = `mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full inline-block ${g.cls}`;
  }

  if (key === 'overall') {
    const ctx = document.getElementById('overall-context');
    if (ctx) ctx.textContent = scoreContext(score);
  }

  // Ring color: green ≥70, amber 40-69, red <40
  const ringColor = score >= 70 ? '#16a34a' : score >= 40 ? '#d97706' : '#ea580c';
  animateRing(ringId, score, ringColor);
}

// SSE with auto-reconnect (up to 2 retries on network error)
function openAuditStream(domain, attempt) {
  const es = new EventSource(`${API}/api/audit/${encodeURIComponent(domain)}`);

  es.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    updateModuleProgress(d.module, d.status, d.detail);
  });

  es.addEventListener('section', (e) => {
    const d = JSON.parse(e.data);
    if (d.module !== 'cache_hit') {
      renderSection(d);
      if (PROGRESS_MODULES.has(d.module)) { tickProgress(); clearTimeout(window._catCountTimer); window._catCountTimer = setTimeout(updateCatTabCounts, 120); }
    } else {
      renderFullAudit(d.data);
      // Instantly complete progress bar for cached results
      modulesComplete = TOTAL_MODULES;
      const fill = document.getElementById('progress-fill');
      const label = document.getElementById('progress-label');
      if (fill) fill.style.width = '100%';
      if (label) label.textContent = `${TOTAL_MODULES} / ${TOTAL_MODULES} modules`;
      stopAuditTimer();
      setTimeout(() => { const bar = document.getElementById('progress-bar'); if (bar) bar.classList.add('hidden'); }, 800);
    }
  });

  es.addEventListener('complete', (e) => {
    const d = JSON.parse(e.data);
    currentAuditId = d.audit_id;
    stopAuditTimer();
    renderFullAudit(d);
    enableChat();
    es.close();
  });

  es.addEventListener('error', () => {
    es.close();
    if (attempt < 2) {
      setTimeout(() => openAuditStream(domain, attempt + 1), 2000 * (attempt + 1));
      appendError(`Connection interrupted — retrying (${attempt + 1}/2)...`, true);
    } else {
      stopAuditTimer();
      appendError('Audit failed or timed out. Please try again.');
      // Clear any modules stuck on spinner
      document.querySelectorAll('[id^="module-"] .spinner').forEach(spinner => {
        const card = spinner.closest('[id^="module-"]');
        if (card) renderSection({ module: card.id.replace('module-', ''), status: 'failed', error: 'Timed out', duration_ms: null });
      });
    }
  });
}

function renderFullAudit(data) {
  if (!data?.domain) return;
  const auditDate = data.created_at ? new Date(data.created_at).toLocaleString() : new Date().toLocaleString();
  // Track recent audits in localStorage
  saveRecentAudit(data.domain);
  renderRecentAudits();

  // Update domain header
  const nameEl = document.getElementById('domain-name');
  const dateEl = document.getElementById('audit-date');
  const faviconEl = document.getElementById('domain-favicon');
  if (nameEl) nameEl.textContent = data.domain;
  if (dateEl) dateEl.textContent = `Audit complete · ${auditDate}`;
  if (faviconEl && !faviconEl.querySelector('img')) {
    faviconEl.innerHTML = `<img src="https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(data.domain)}" alt="" class="w-6 h-6" onerror="this.style.display='none'">`;
  }
  // Set data-domain on score-header for print header
  const hdr = document.getElementById('score-header');
  if (hdr) hdr.dataset.domain = data.domain;

  // Score rings
  if (data.overall_score !== undefined) {
    const scoresEl = document.getElementById('scores');
    scoresEl.classList.remove('hidden');
    // Brief pop-in animation on reveal
    scoresEl.classList.remove('score-reveal');
    void scoresEl.offsetWidth; // reflow to re-trigger
    scoresEl.classList.add('score-reveal');

    setScoreCircle('overall', data.overall_score, '#2563eb');
    setScoreCircle('seo',     data.seo_score ?? 0,     '#2563eb');
    setScoreCircle('geo',     data.geo_score ?? 0,     '#7c3aed');

    // Cross-metric insight appended to overall context
    const _seo = data.seo_score ?? 0, _geo = data.geo_score ?? 0;
    // setScoreCircle already sets overall-context; we enrich it after
    requestAnimationFrame(() => {
      const ctxEl = document.getElementById('overall-context');
      if (!ctxEl) return;
      const delta = Math.abs(_seo - _geo);
      if (delta >= 20) {
        const weaker = _seo < _geo ? 'SEO' : 'AI visibility';
        ctxEl.textContent = scoreContext(data.overall_score) + ` · improve ${weaker}`;
      }
    });

    // Performance score: PageSpeed first, CrUX composite as fallback
    const ps = data.modules?.on_page_seo?.data?.page_speed;
    const cruxData = data.modules?.crux?.data;
    const perfScore = ps?.performance ?? (cruxData?.has_data ? cruxData.performance_score : null);
    if (perfScore !== null) {
      setScoreCircle('perf', perfScore, '#16a34a');
    } else {
      // No CrUX data — hide the entire performance circle so there's no empty ring
      const perfWrap = document.getElementById('perf-circle-wrap');
      if (perfWrap) perfWrap.style.display = 'none';
    }

    // CWV pill row
    if (ps) {
      const cwvRow = document.getElementById('cwv-row');
      if (cwvRow) {
        const pills = [
          ps.lcp_s  != null && cwvPill('LCP',  ps.lcp_s.toFixed(1)  + 's', ps.lcp_s  <= 2.5 ? 'good' : ps.lcp_s  <= 4   ? 'needs' : 'poor'),
          ps.cls    != null && cwvPill('CLS',  ps.cls.toFixed(3),           ps.cls    <= 0.1  ? 'good' : ps.cls    <= 0.25 ? 'needs' : 'poor'),
          ps.fcp_s  != null && cwvPill('FCP',  ps.fcp_s.toFixed(1)  + 's', ps.fcp_s  <= 1.8  ? 'good' : ps.fcp_s  <= 3   ? 'needs' : 'poor'),
          ps.ttfb_s != null && cwvPill('TTFB', ps.ttfb_s.toFixed(2) + 's', ps.ttfb_s <= 0.8  ? 'good' : ps.ttfb_s <= 1.8 ? 'needs' : 'poor'),
          ps.tbt_ms != null && cwvPill('TBT',  ps.tbt_ms + 'ms',           ps.tbt_ms <= 200  ? 'good' : ps.tbt_ms <= 600 ? 'needs' : 'poor'),
        ].filter(Boolean).join('');
        cwvRow.innerHTML = `<div class="flex flex-wrap gap-2 justify-center">${pills}</div>`;
        cwvRow.classList.remove('hidden');
      }
    }
  }

  // Score delta from localStorage
  const lsKey = `geoscore:${data.domain}`;
  const prev = (() => { try { return JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch { return null; } })();
  if (prev && data.overall_score !== undefined) {
    const delta = data.overall_score - (prev.overall ?? data.overall_score);
    const deltaEl = document.getElementById('overall-delta');
    if (deltaEl && delta !== 0) {
      const sign = delta > 0 ? '▲ +' : '▼ ';
      deltaEl.textContent = `${sign}${delta} since last check`;
      deltaEl.className = `text-[10px] font-semibold mt-0.5 ${delta > 0 ? 'text-green-600' : 'text-orange-500'}`;
      deltaEl.classList.remove('hidden');
    }
  }
  // Save scores for next visit
  if (data.overall_score !== undefined) {
    const ps = data.modules?.on_page_seo?.data?.page_speed;
    localStorage.setItem(lsKey, JSON.stringify({
      overall: data.overall_score, seo: data.seo_score, geo: data.geo_score,
      perf: ps?.performance ?? null, ts: Date.now(),
    }));
  }

  // Wire action buttons
  wireActionButtons(data);

  if (data.modules) {
    Object.entries(data.modules).forEach(([name, result]) => {
      const el = document.getElementById(`module-${name}`);
      if (!el || el.querySelector('.spinner')) renderSection({ module: name, ...result });
    });
  }

  // Pass/Fail summary bar
  if (data.modules) {
    let passed = 0, warnings = 0, critical = 0;
    Object.values(data.modules).forEach((m) => {
      if (m.status === 'ok') passed++;
      else if (m.status === 'partial') warnings++;
      else if (m.status === 'failed') critical++;
    });
    const bar = document.getElementById('summary-bar');
    if (bar) {
      bar.innerHTML = [
        passed   ? `<span class="flex items-center gap-1.5 text-green-700 font-medium"><span class="w-4 h-4 rounded-full bg-green-100 flex items-center justify-center text-[10px]">✓</span>${passed} passed</span>` : '',
        warnings ? `<span class="flex items-center gap-1.5 text-amber-700 font-medium"><span class="w-4 h-4 rounded-full bg-amber-100 flex items-center justify-center text-[10px]">⚠</span>${warnings} warnings</span>` : '',
        critical ? `<span class="flex items-center gap-1.5 text-orange-700 font-medium"><span class="w-4 h-4 rounded-full bg-orange-100 flex items-center justify-center text-[10px]">✗</span>${critical} critical</span>` : '',
      ].filter(Boolean).join('<span class="text-slate-300">·</span>');
      bar.classList.remove('hidden');
    }
  }

  if (data.modules?.recommendations?.data?.length) {
    renderRecommendations(data.modules.recommendations.data);
  }

  renderComputedSections(data);

  // Update category tab counts once all cards are inserted
  setTimeout(updateCatTabCounts, 350);

  // Show embed CTA after audit
  document.getElementById('embed-cta')?.classList.remove('hidden');
}

function cwvPill(label, value, status) {
  const cls = { good: 'cwv-good', needs: 'cwv-needs', poor: 'cwv-poor' }[status] ?? 'cwv-needs';
  const icon = status === 'good' ? '✓' : status === 'poor' ? '✗' : '~';
  return `<span class="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full ${cls}">
    ${icon} <span class="font-bold">${label}</span> ${esc(value)}
  </span>`;
}

function wireActionButtons(data) {
  // Nav "Start Fresh" button — show it now that we have a domain, wire once
  const navFreshBtn = document.getElementById('nav-fresh-btn');
  if (navFreshBtn) {
    navFreshBtn.classList.remove('hidden');
    if (!navFreshBtn.dataset.wired) {
      navFreshBtn.dataset.wired = '1';
      navFreshBtn.addEventListener('click', async () => {
        navFreshBtn.disabled = true;
        navFreshBtn.textContent = 'Clearing…';
        try {
          await fetch(`${API}/api/audit/${encodeURIComponent(data.domain)}/cache`, { method: 'DELETE' });
        } catch { /* proceed anyway */ }
        computedSectionsRendered = false;
        document.getElementById('modules').innerHTML = '';
        document.getElementById('scores').classList.add('hidden');
        navFreshBtn.disabled = false;
        navFreshBtn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Start Fresh`;
        navFreshBtn.dataset.wired = '';
        openAuditStream(data.domain, 0);
      });
    }
  }

  // Re-audit — clears KV cache then restarts the audit stream
  const reauditBtn = document.getElementById('reaudit-btn');
  if (reauditBtn && !reauditBtn.dataset.wired) {
    reauditBtn.dataset.wired = '1';
    reauditBtn.addEventListener('click', async () => {
      reauditBtn.disabled = true;
      reauditBtn.textContent = 'Clearing…';
      try {
        await fetch(`${API}/api/audit/${encodeURIComponent(data.domain)}/cache`, { method: 'DELETE' });
      } catch { /* ignore — proceed anyway */ }
      // Reset UI and re-run
      computedSectionsRendered = false;
      document.getElementById('modules').innerHTML = '';
      document.getElementById('scores').classList.add('hidden');
      reauditBtn.disabled = false;
      reauditBtn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Re-audit`;
      reauditBtn.dataset.wired = '';
      openAuditStream(data.domain, 0);
    });
  }

  // Share link — copies current URL (already has ?d=domain from pushState)
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn && !shareBtn.dataset.wired) {
    shareBtn.dataset.wired = '1';
    shareBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const orig = shareBtn.innerHTML;
        shareBtn.textContent = '✓ Link copied!';
        shareBtn.classList.add('text-green-600', 'border-green-300');
        setTimeout(() => { shareBtn.innerHTML = orig; shareBtn.classList.remove('text-green-600', 'border-green-300'); }, 2500);
      }).catch(() => {
        prompt('Copy this link:', window.location.href);
      });
    });
  }

  // PDF export
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn && !exportBtn.dataset.wired) {
    exportBtn.dataset.wired = '1';
    exportBtn.addEventListener('click', () => window.print());
  }

  // Monitor toggle
  const monitorBtn = document.getElementById('monitor-btn');
  const monitorBanner = document.getElementById('monitor-banner');
  if (monitorBtn && monitorBanner && !monitorBtn.dataset.wired) {
    monitorBtn.dataset.wired = '1';
    monitorBtn.addEventListener('click', () => {
      const open = monitorBanner.style.maxHeight !== '0px' && monitorBanner.style.maxHeight !== '';
      monitorBanner.style.maxHeight  = open ? '0' : '200px';
      monitorBanner.style.opacity    = open ? '0' : '1';
    });
  }
  const monitorSubmit = document.getElementById('monitor-submit');
  if (monitorSubmit && !monitorSubmit.dataset.wired) {
    monitorSubmit.dataset.wired = '1';
    monitorSubmit.addEventListener('click', async () => {
      const email = document.getElementById('monitor-email')?.value?.trim();
      const msg   = document.getElementById('monitor-msg');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (msg) { msg.textContent = 'Enter a valid email address.'; msg.classList.remove('hidden'); }
        return;
      }
      monitorSubmit.disabled = true;
      monitorSubmit.textContent = 'Subscribing…';
      try {
        const res = await fetch(`${API}/api/monitor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: data.domain, email }),
        });
        const json = await res.json().catch(() => ({}));
        if (msg) {
          msg.textContent = res.ok ? '✓ Subscribed! You\'ll get weekly alerts if your scores change.' : (json.error || 'Failed to subscribe. Try again.');
          msg.classList.remove('hidden');
          msg.className = `text-xs mt-1.5 ${res.ok ? 'text-green-700' : 'text-orange-600'}`;
        }
      } catch {
        if (msg) { msg.textContent = 'Network error. Try again.'; msg.classList.remove('hidden'); }
      } finally {
        monitorSubmit.disabled = false;
        monitorSubmit.textContent = 'Subscribe';
      }
    });
  }

  // Embed
  const showEmbedBtn = document.getElementById('show-embed-btn');
  if (showEmbedBtn && !showEmbedBtn.dataset.wired) {
    showEmbedBtn.dataset.wired = '1';
    showEmbedBtn.addEventListener('click', () => showEmbedCode(data.domain));
  }
}


function showEmbedCode(domain) {
  const existing = document.getElementById('card-embed-code');
  if (existing) { existing.scrollIntoView({ behavior: 'smooth' }); return; }
  const embedUrl = `https://geoscoreapp.pages.dev/?d=${encodeURIComponent(domain)}`;
  const scriptTag = `<script src="https://audit-api.sprawf.workers.dev/embed.js" data-domain="${domain}" async><\/script>`;
  const el = document.createElement('div');
  el.id = 'card-embed-code';
  el.className = 'bg-white rounded-xl border border-slate-200 p-4 fade-in';
  el.style.order = cardOrder('card-embed-code');
  el.dataset.category = 'previews';
  el.innerHTML = `
    <div class="font-semibold text-sm mb-3">🔗 Embed Widget</div>
    <p class="text-xs text-slate-500 mb-3">Add a live GeoScore badge to any website or documentation:</p>
    <div class="space-y-2">
      <div>
        <div class="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Script embed (badge)</div>
        <div class="relative">
          <pre class="text-[10px] bg-slate-900 text-green-300 p-3 rounded-lg overflow-x-auto leading-relaxed">${esc(scriptTag)}</pre>
          <button onclick="navigator.clipboard.writeText(${JSON.stringify(scriptTag)}).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',2000)})"
            class="absolute top-2 right-2 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-0.5 rounded transition-colors">Copy</button>
        </div>
      </div>
      <div>
        <div class="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Direct link</div>
        <a href="${esc(embedUrl)}" target="_blank" class="text-xs text-blue-600 underline break-all">${esc(embedUrl)}</a>
      </div>
    </div>`;
  document.getElementById('modules').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateModuleProgress(name, status, detail) {
  if (name === 'cache') return; // cache is internal — never show as a card
  // These modules are rendered by renderComputedSections, not as streaming cards.
  // Without this guard, they'd get a permanent spinner that never resolves.
  if (name === 'recommendations' || name === 'keywords' || name === 'competitor_snapshot') return;
  if (document.getElementById(`module-${name}`)) return;
  const el = document.createElement('div');
  el.id = `module-${name}`;
  el.className = 'bg-white rounded-xl border border-slate-200 p-4 fade-in';
  el.dataset.category = MODULE_CATEGORY[name] || 'seo';
  el.innerHTML = `
    <div class="flex items-center gap-2">
      <svg class="spinner w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
      <span class="font-medium text-sm capitalize">${moduleName(name)}</span>
      <span class="module-elapsed text-xs font-mono text-blue-400 ml-auto" data-start-ms="${Date.now()}">0s</span>
    </div>`;
  el.style.order = cardOrder(el.id);
  document.getElementById('modules').appendChild(el);
  applyActiveCatFilter(el);
}

function renderSection(d) {
  if (d.module === 'recommendations' || d.module === 'keywords' || d.module === 'competitor_snapshot') return;

  // ── Bot-challenge / WAF interstitial warning banner ───────────────────────
  // When a site blocks automated fetches (CAPTCHA, Cloudflare challenge, etc.)
  // we emit a 'bot_blocked' section.  Show a prominent amber banner at the
  // top of the results so users understand that module scores are limited,
  // rather than seeing unexplained zeros and trusting them as real findings.
  if (d.module === 'bot_blocked') {
    const data = d.data ?? {};
    const reason = data.reason ?? 'Bot-challenge page detected';
    const note = data.note ?? 'Page content could not be analysed — scores reflect domain-level signals only.';
    let banner = document.getElementById('module-bot_blocked');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'module-bot_blocked';
      // Prepend so it always appears first, above all module cards
      const modulesEl = document.getElementById('modules');
      modulesEl.insertBefore(banner, modulesEl.firstChild);
    }
    banner.className = 'rounded-xl border border-amber-300 bg-amber-50 p-4 fade-in flex gap-3 items-start';
    banner.dataset.category = 'all'; // always visible regardless of active filter
    banner.innerHTML = `
      <span class="text-2xl leading-none mt-0.5" aria-hidden="true">🛡️</span>
      <div class="min-w-0">
        <p class="font-semibold text-amber-800 text-sm">Bot Protection Detected — Limited Analysis</p>
        <p class="text-amber-700 text-sm mt-0.5">${esc(note)}</p>
        <p class="text-amber-600 text-xs mt-1.5 font-mono bg-amber-100 rounded px-2 py-1 inline-block">${esc(reason)}</p>
      </div>`;
    return;
  }

  // ── Silently suppress AI-unavailable results ──────────────────────────────
  // status='skipped' → AI quota hit / unavailable, no useful data.
  // is_reliable=false → AI failed entirely; only generic template fallback returned.
  // In both cases the user sees nothing rather than a placeholder or stale guess.
  if (d.status === 'skipped' || d.data?.is_reliable === false) {
    const existing = document.getElementById(`module-${d.module}`);
    if (existing) existing.remove();
    return;
  }

  let el = document.getElementById(`module-${d.module}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `module-${d.module}`;
    el.className = 'bg-white rounded-xl border border-slate-200 p-5 fade-in';
    document.getElementById('modules').appendChild(el);
  }
  el.style.order = cardOrder(el.id);
  el.dataset.category = MODULE_CATEGORY[d.module] || 'seo';

  const statusIcon = {
    ok:      '<span class="text-green-600 text-lg">✓</span>',
    failed:  '<span class="text-orange-500 text-lg">✗</span>',
    skipped: '<span class="text-slate-400 text-lg">—</span>',
    partial: '<span class="text-yellow-500 text-lg">⚠</span>',
  }[d.status] ?? '<span class="text-slate-400 text-lg">—</span>';
  const data = d.data;
  const ms = d.duration_ms != null ? `<span class="text-sm text-slate-300 ml-auto">${d.duration_ms < 1000 ? d.duration_ms + 'ms' : (d.duration_ms / 1000).toFixed(1) + 's'}</span>` : '';
  let detail = '';

  if (d.module === 'technical_seo' && data) {
    const issues = (data.issues ?? []).slice(0, 6).map(i =>
      `<li class="text-sm ${i.startsWith('CRITICAL') ? 'text-orange-700 font-semibold' : 'text-blue-600'}">• ${esc(i)}</li>`
    ).join('');

    const sh = data.security_headers ?? {};
    const secScore = sh.score ?? 0;
    const secBar = secScore >= 80 ? 'bg-green-400' : secScore >= 50 ? 'bg-yellow-400' : 'bg-orange-400';
    const secText = secScore >= 80 ? 'text-green-700' : secScore >= 50 ? 'text-yellow-700' : 'text-orange-600';
    const checksTotal = (data.checks ?? []).length;
    const checksPassed = (data.checks ?? []).filter(c => c.passed).length;
    const scoreNum = data.score ?? 0;
    const scoreBar = scoreNum >= 80 ? 'bg-green-400' : scoreNum >= 60 ? 'bg-yellow-400' : 'bg-orange-400';
    const scoreText = scoreNum >= 80 ? 'text-green-700' : scoreNum >= 60 ? 'text-yellow-700' : 'text-orange-600';
    const ttfb = data.response_time_ms ?? 0;
    const ttfbColor = ttfb < 800 ? 'text-green-700' : ttfb < 2000 ? 'text-yellow-700' : 'text-orange-600';
    const secHeaderItems = [
      { label: 'HSTS', val: sh.hsts }, { label: 'X-Content', val: sh.xcontent },
      { label: 'X-Frame', val: sh.xframe }, { label: 'CSP', val: sh.csp },
      { label: 'Referrer', val: sh.referrer }, { label: 'Permissions', val: sh.permissions },
    ].map(h => `<div class="flex items-center gap-1.5">
      <span class="${h.val ? 'text-green-600' : 'text-orange-500'} font-semibold">${h.val ? '✓' : '✗'}</span>
      <span class="text-sm text-slate-600">${h.label}</span>
    </div>`).join('');

    detail = `<div class="mt-3 space-y-3">
      <div class="flex items-center gap-3">
        <div class="flex-1 bg-slate-100 rounded-full h-2.5">
          <div class="${scoreBar} h-2.5 rounded-full" style="width:${scoreNum}%"></div>
        </div>
        <span class="text-base font-bold ${scoreText} shrink-0">${scoreNum}/100</span>
        ${checksTotal ? `<span class="text-sm text-slate-400 shrink-0">${checksPassed}/${checksTotal} checks</span>` : ''}
      </div>
      <div class="grid grid-cols-3 gap-2 text-center">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold ${ttfbColor}">${ttfb}ms</div>
          <div class="text-xs text-slate-400 mt-0.5">Response time</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold text-slate-700">${data.page_weight_kb ?? '—'}KB</div>
          <div class="text-xs text-slate-400 mt-0.5">Page weight</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold ${(data.sitemap_url_count ?? 0) > 0 ? 'text-green-700' : 'text-orange-600'}">${(data.sitemap_url_count ?? 0) > 0 ? data.sitemap_url_count : '✗'}</div>
          <div class="text-xs text-slate-400 mt-0.5">Sitemap URLs</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span class="${data.blocked_ai_bots ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-green-50 text-green-700 border-green-200'} border text-xs px-2.5 py-1 rounded-full font-medium">${data.blocked_ai_bots ? '🚫 AI bots blocked' : '✓ AI bots allowed'}</span>
        <span class="${data.llms_txt_present ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-100 text-slate-500 border-slate-200'} border text-xs px-2.5 py-1 rounded-full font-medium">${data.llms_txt_present ? '✓ llms.txt' : '✗ No llms.txt'}</span>
        ${data.compression?.enabled ? `<span class="bg-blue-50 text-blue-700 border border-blue-200 text-xs px-2.5 py-1 rounded-full font-medium">${esc(data.compression.encoding)} ✓</span>` : '<span class="bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2.5 py-1 rounded-full font-medium">No compression</span>'}
        ${(data.render_blocking_scripts ?? 0) > 0 ? `<span class="bg-amber-50 text-amber-700 border border-amber-200 text-xs px-2.5 py-1 rounded-full font-medium">⚠ ${data.render_blocking_scripts} blocking scripts</span>` : ''}
        ${data.dom_element_count ? `<span class="text-xs text-slate-500 border border-slate-200 px-2.5 py-1 rounded-full">${data.dom_element_count} DOM elements</span>` : ''}
      </div>
      <div class="border border-slate-100 rounded-lg p-3 bg-slate-50/50">
        <div class="flex items-center justify-between mb-2.5">
          <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Security headers</span>
          <div class="flex items-center gap-2">
            <div class="w-24 bg-slate-200 rounded-full h-1.5"><div class="${secBar} h-1.5 rounded-full" style="width:${secScore}%"></div></div>
            <span class="text-sm font-semibold ${secText}">${secScore}/100</span>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-x-4 gap-y-1.5">${secHeaderItems}</div>
      </div>
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'schema_audit' && data) {
    const missing = Object.entries(data.coverage || {}).filter(([, v]) => !v).map(([k]) => k);
    const present = Object.entries(data.coverage || {}).filter(([, v]) => v).map(([k]) => k);
    const scoreNum = data.score ?? 0;
    const scoreBar = scoreNum >= 80 ? 'bg-green-400' : scoreNum >= 50 ? 'bg-yellow-400' : 'bg-orange-400';
    const scoreText = scoreNum >= 80 ? 'text-green-700' : scoreNum >= 50 ? 'text-yellow-700' : 'text-orange-600';
    const foundCount = (data.schemas_found ?? []).length;
    const ecomSection = data.is_ecommerce ? (() => {
      const ecMissing = Object.entries(data.ecommerce_coverage || {}).filter(([, v]) => !v).map(([k]) => k);
      const ecPresent = Object.entries(data.ecommerce_coverage || {}).filter(([, v]) => v).map(([k]) => k);
      return `<div class="p-3 rounded-lg bg-amber-50 border border-amber-200">
        <div class="text-sm font-semibold text-amber-700 mb-1.5">🛒 E-commerce schema audit</div>
        ${ecPresent.length ? `<div class="text-sm text-green-700">✓ Present: ${ecPresent.join(', ')}</div>` : ''}
        ${ecMissing.length ? `<div class="text-sm text-orange-600 mt-1">✗ Missing: ${ecMissing.join(', ')}</div>` : '<div class="text-sm text-green-600 mt-1">All shopping schemas present ✓</div>'}
      </div>`;
    })() : '';
    detail = `<div class="mt-3 space-y-3">
      <div class="flex items-center gap-3">
        <div class="flex-1 bg-slate-100 rounded-full h-2.5">
          <div class="${scoreBar} h-2.5 rounded-full" style="width:${scoreNum}%"></div>
        </div>
        <span class="text-base font-bold ${scoreText} shrink-0">${scoreNum}/100</span>
        <span class="text-sm text-slate-400 shrink-0">${foundCount} schema${foundCount !== 1 ? 's' : ''} found</span>
      </div>
      ${present.length ? `<div>
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Present</div>
        <div class="flex flex-wrap gap-1.5">${present.map(s => `<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✓ ${esc(s)}</span>`).join('')}</div>
      </div>` : ''}
      ${missing.length ? `<div>
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Missing opportunities</div>
        <div class="flex flex-wrap gap-1.5">${missing.map(s => `<span class="bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2.5 py-1 rounded-full">✗ ${esc(s)}</span>`).join('')}</div>
      </div>` : (present.length > 0 || foundCount > 0) ? '<div class="text-sm text-green-600 font-medium">✓ All recommended schemas present</div>' : '<div class="text-sm text-slate-400">No structured data detected — consider adding JSON-LD schema markup</div>'}
      ${data.schemas_found?.length ? `<div class="text-sm text-slate-500">Schema types detected: ${data.schemas_found.map(s => `<span class="font-medium text-slate-700">${esc(s)}</span>`).join(', ')}</div>` : ''}
      ${ecomSection}
    </div>`;

  } else if (d.module === 'content_quality' && data) {
    const issues = (data.issues ?? []).slice(0, 5).map(i =>
      `<li class="text-sm ${i.startsWith('CRITICAL') ? 'text-orange-700 font-semibold' : 'text-blue-600'}">• ${tipify(esc(i))}</li>`
    ).join('');
    const scoreNum = data.score ?? 0;
    const scoreBar = scoreNum >= 80 ? 'bg-green-400' : scoreNum >= 60 ? 'bg-yellow-400' : 'bg-orange-400';
    const scoreText = scoreNum >= 80 ? 'text-green-700' : scoreNum >= 60 ? 'text-yellow-700' : 'text-orange-600';
    const wordColor = (data.word_count ?? 0) >= 300 ? 'text-green-700' : (data.word_count ?? 0) >= 150 ? 'text-yellow-700' : 'text-orange-600';
    const altPct = data.alt_coverage_pct ?? 0;
    const altColor = altPct >= 90 ? 'text-green-700' : altPct >= 60 ? 'text-yellow-700' : 'text-orange-600';
    detail = `<div class="mt-3 space-y-3">
      <div class="flex items-center gap-3">
        <div class="flex-1 bg-slate-100 rounded-full h-2.5">
          <div class="${scoreBar} h-2.5 rounded-full" style="width:${scoreNum}%"></div>
        </div>
        <span class="text-base font-bold ${scoreText} shrink-0">${scoreNum}/100</span>
      </div>
      <div class="grid grid-cols-4 gap-2 text-center">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold ${wordColor}">${data.word_count ?? 0}</div>
          <div class="text-xs text-slate-400 mt-0.5">Words</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold text-slate-700">${data.h2_count ?? 0}</div>
          <div class="text-xs text-slate-400 mt-0.5">H2 headings</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold text-slate-700">${data.image_count ?? 0}</div>
          <div class="text-xs text-slate-400 mt-0.5">Images</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-sm font-bold ${altColor}">${altPct}%</div>
          <div class="text-xs text-slate-400 mt-0.5">Alt coverage</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span class="${data.has_phone ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'} border text-xs px-2.5 py-1 rounded-full font-medium">${data.has_phone ? '📞 Phone number' : '⚠ No phone number'}</span>
        ${data.has_address ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">📍 Address present</span>' : ''}
        ${data.has_email ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✉ Email present</span>' : ''}
        ${data.language ? `<span class="bg-slate-100 text-slate-600 border border-slate-200 text-xs px-2.5 py-1 rounded-full">🌐 ${esc(data.language)}</span>` : ''}
      </div>
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'authority' && data) {
    const ageYrs = data.domain_age_years ?? 0;
    const ageBar = ageYrs >= 10 ? 'bg-green-400' : ageYrs >= 5 ? 'bg-yellow-400' : ageYrs >= 2 ? 'bg-blue-400' : 'bg-orange-400';
    const ageText = ageYrs >= 10 ? 'text-green-700' : ageYrs >= 5 ? 'text-yellow-700' : ageYrs >= 2 ? 'text-blue-600' : 'text-orange-600';
    const opr = data.page_rank;
    const oprBar = opr != null ? (opr >= 7 ? 'bg-green-400' : opr >= 4 ? 'bg-yellow-400' : 'bg-orange-400') : '';
    const oprText = opr != null ? (opr >= 7 ? 'text-green-700' : opr >= 4 ? 'text-yellow-700' : 'text-orange-600') : '';
    const backlinks = data.backlink_sample_count ?? 0;
    detail = `<div class="mt-3 space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Domain age</div>
          <div class="flex items-center gap-2 mb-1.5">
            <div class="flex-1 bg-slate-200 rounded-full h-2"><div class="${ageBar} h-2 rounded-full" style="width:${Math.min(100, ageYrs * 5)}%"></div></div>
            <span class="text-sm font-bold ${ageText} shrink-0">${ageYrs} yrs</span>
          </div>
          <div class="text-xs text-slate-400">${ageYrs >= 10 ? 'Highly established' : ageYrs >= 5 ? 'Established' : ageYrs >= 2 ? 'Growing' : 'New domain'}</div>
        </div>
        ${opr != null ? `<div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Open PageRank</div>
          <div class="flex items-center gap-2 mb-1.5">
            <div class="flex-1 bg-slate-200 rounded-full h-2"><div class="${oprBar} h-2 rounded-full" style="width:${opr * 10}%"></div></div>
            <span class="text-sm font-bold ${oprText} shrink-0">${opr.toFixed(1)}/10</span>
          </div>
          <div class="text-xs text-slate-400">${opr >= 7 ? 'High authority' : opr >= 4 ? 'Moderate authority' : 'Low authority'}</div>
        </div>` : '<div class="bg-slate-50 rounded-lg p-3 flex items-center justify-center text-sm text-slate-400">OPR not available</div>'}
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span class="${data.wikipedia ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-100 text-slate-500 border-slate-200'} border text-xs px-2.5 py-1 rounded-full font-medium">${data.wikipedia ? '✓ Wikipedia' : '✗ No Wikipedia'}</span>
        <span class="${data.wikidata_id ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-100 text-slate-500 border-slate-200'} border text-xs px-2.5 py-1 rounded-full font-medium">${data.wikidata_id ? '✓ Wikidata entity' : '✗ No Wikidata'}</span>
        <span class="bg-slate-100 text-slate-600 border border-slate-200 text-xs px-2.5 py-1 rounded-full font-medium">~${backlinks} backlinks sampled</span>
        ${data.wikidata_id ? `<span class="text-xs text-slate-400 self-center font-mono">${esc(data.wikidata_id)}</span>` : ''}
      </div>
    </div>`;

  } else if (d.module === 'geo_predicted' && data) {
    const confPct = Math.round((data.avg_confidence ?? 0) * 100);
    const rate    = Math.round((data.citation_rate   ?? 0) * 100);
    const queries = data.queries ?? [];
    const citedCount = queries.filter(q => q.cited).length;
    const totalQ = queries.length || 1;

    // Visibility score: blend citation rate + avg confidence
    const visScore = Math.round(rate * 0.6 + confPct * 0.4);
    const visColor = visScore >= 60 ? '#16a34a' : visScore >= 35 ? '#d97706' : '#ea580c';
    const visLabel = visScore >= 60 ? 'Good' : visScore >= 35 ? 'Needs work' : 'Poor';
    const visLabelColor = visScore >= 60 ? 'text-green-700' : visScore >= 35 ? 'text-yellow-700' : 'text-orange-600';
    const visLabelBg = visScore >= 60 ? 'bg-green-50 border-green-200' : visScore >= 35 ? 'bg-amber-50 border-amber-200' : 'bg-orange-50 border-orange-200';

    // SVG arc for the big circular gauge
    const circumference = 2 * Math.PI * 38;
    const dashOffset = circumference * (1 - visScore / 100);

    // Simulated AI "search result" query cards
    const queryCards = queries.map((q, i) => {
      const qConf  = Math.round((q.confidence ?? 0) * 100);
      const isCited = q.cited;
      const borderCls = isCited ? 'border-green-200 bg-green-50/40' : 'border-slate-200 bg-white';
      const iconSvg = isCited
        ? `<svg class="w-4 h-4 text-green-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
        : `<svg class="w-4 h-4 text-slate-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 9l-6 6M9 9l6 6"/></svg>`;
      const badge = isCited
        ? `<span class="text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full shrink-0">Cited · ${qConf}%</span>`
        : `<span class="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full shrink-0">Not cited · ${qConf}%</span>`;
      return `
        <div class="border ${borderCls} rounded-xl p-3">
          <div class="flex items-start gap-2 mb-1.5">
            ${iconSvg}
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Query ${i + 1}</div>
              <div class="text-sm font-medium text-slate-800">&ldquo;${esc(q.query)}&rdquo;</div>
            </div>
            ${badge}
          </div>
          ${q.reasoning ? `<div class="text-xs text-slate-500 leading-relaxed ml-6">${esc(q.reasoning)}</div>` : ''}
        </div>`;
    }).join('');

    // Verdict copy
    const verdict = citedCount === totalQ
      ? `AI engines would cite ${esc(currentDomain)} for all ${totalQ} test queries — excellent visibility.`
      : citedCount === 0
      ? `AI engines wouldn't cite ${esc(currentDomain)} for any of the ${totalQ} test queries. See recommendations below to fix this.`
      : `AI engines would cite ${esc(currentDomain)} for ${citedCount} of ${totalQ} test queries.`;

    const overrideApplied = !!data.vertical_override_applied;
    const verticalBadge = data.vertical ? `
      <span class="text-[10px] font-medium px-2 py-0.5 rounded-full border
        ${overrideApplied ? 'bg-green-50 text-green-700 border-green-200' : 'bg-blue-50 text-blue-700 border-blue-200'}">
        ${esc(data.vertical)}${overrideApplied ? ' ✓' : ''}
      </span>
      <button onclick="openVerticalCorrection('${esc(currentDomain)}', '${esc(data.vertical)}')"
        class="text-[10px] text-slate-400 hover:text-orange-500 transition-colors" title="Correct vertical">&#9998;</button>
    ` : '';

    detail = `<div class="mt-4 space-y-4">

      <!-- Hero: circular gauge + summary stats -->
      <div class="flex items-center gap-5">
        <!-- Radial gauge -->
        <div class="relative w-24 h-24 shrink-0">
          <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r="38" fill="none" stroke="#e2e8f0" stroke-width="10" stroke-linecap="round"/>
            <circle cx="50" cy="50" r="38" fill="none" stroke="${visColor}" stroke-width="10" stroke-linecap="round"
              stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
              class="score-ring"/>
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="text-xl font-extrabold text-slate-900 leading-none">${visScore}</span>
            <span class="text-[9px] text-slate-400">/100</span>
          </div>
        </div>
        <!-- Stats -->
        <div class="flex-1 space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-sm font-bold text-slate-900">AI Visibility</span>
            <span class="text-xs font-semibold px-2 py-0.5 rounded-full border ${visLabelColor} ${visLabelBg}">${visLabel}</span>
          </div>
          <p class="text-xs text-slate-500 leading-relaxed">${verdict}</p>
          <div class="flex flex-wrap gap-2 text-[10px]">
            <span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200">
              ${citedCount}/${totalQ} queries cited
            </span>
            <span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200">
              ${confPct}% avg confidence
            </span>
            ${verticalBadge}
            ${data.location && data.location !== 'your area' ? `<span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200">📍 ${esc(data.location)}</span>` : ''}
          </div>
        </div>
      </div>

      <!-- Query cards -->
      ${queryCards ? `
        <div>
          <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Simulated AI search queries</div>
          <div class="space-y-2">${queryCards}</div>
        </div>` : ''}

    </div>`;

  } else if (d.module === 'on_page_seo' && data) {
    const ps = data.page_speed;
    const cwv = ps ? [
      ps.lcp_s != null && scoreVitals(ps.lcp_s, 2.5, 4, 'LCP', ps.lcp_s.toFixed(1) + 's'),
      ps.cls != null && scoreVitals(ps.cls, 0.1, 0.25, 'CLS', ps.cls.toFixed(3)),
      ps.fcp_s != null && scoreVitals(ps.fcp_s, 1.8, 3, 'FCP', ps.fcp_s.toFixed(1) + 's'),
      ps.ttfb_s != null && scoreVitals(ps.ttfb_s, 0.8, 1.8, 'TTFB', ps.ttfb_s.toFixed(2) + 's'),
    ].filter(Boolean).join('') : '';
    const issues = (data.issues ?? []).slice(0, 6).map(i =>
      `<li class="text-sm text-blue-600${i.startsWith('No H1') || i.startsWith('LCP') ? ' font-semibold text-orange-600' : ''}">• ${tipify(esc(i))}</li>`
    ).join('');
    const headings = data.headings ?? {};
    const imgs = data.images ?? {};
    const content = data.content ?? {};
    detail = `<div class="mt-3 space-y-3">
      ${ps ? `<div class="grid grid-cols-2 gap-2">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Performance</div>
          <div class="text-base font-bold ${ps.performance >= 90 ? 'text-green-700' : ps.performance >= 50 ? 'text-yellow-700' : 'text-orange-600'}">${ps.performance}/100</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Accessibility</div>
          <div class="text-base font-bold ${ps.accessibility >= 90 ? 'text-green-700' : ps.accessibility >= 70 ? 'text-yellow-700' : 'text-orange-600'}">${ps.accessibility}/100</div>
        </div>
      </div>` : '<div class="text-sm text-slate-400 italic">PageSpeed data unavailable</div>'}
      <div class="flex flex-wrap gap-2 text-sm text-slate-600">
        ${headings.h1 != null ? `<span class="bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">H1: <strong>${headings.h1}</strong></span>` : ''}
        ${headings.h2 != null ? `<span class="bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">H2: <strong>${headings.h2}</strong></span>` : ''}
        ${headings.h3 != null ? `<span class="bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">H3: <strong>${headings.h3}</strong></span>` : ''}
        ${content.word_count != null ? `<span class="bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg"><strong>${content.word_count}</strong> words · <strong>${content.reading_time_min ?? 0}</strong>min</span>` : ''}
        ${data.links ? `<span class="bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg"><strong>${data.links.internal}</strong> internal · <strong>${data.links.external}</strong> external</span>` : ''}
        ${imgs.total != null ? `<span class="bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg"><strong>${imgs.total}</strong> imgs · <strong>${imgs.missing_alt ?? 0}</strong> no-alt</span>` : ''}
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${content.has_faq != null ? (content.has_faq ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✓ FAQ section</span>' : '<span class="bg-amber-50 text-amber-700 border border-amber-200 text-xs px-2.5 py-1 rounded-full">✗ No FAQ</span>') : ''}
        ${content.has_video ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✓ Video content</span>' : ''}
      </div>
      ${cwv ? `<div class="flex flex-wrap gap-2">${cwv}</div>` : ''}
      ${ps?.opportunities?.length ? `<div class="text-sm text-slate-500">⚡ ${ps.opportunities.slice(0, 2).map(esc).join(' · ')}</div>` : ''}
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'off_page_seo' && data) {
    const socials = (data.social_profiles ?? []);
    const em = data.email_security ?? {};
    const brand = data.brand_presence ?? {};
    const issues = (data.issues ?? []).slice(0, 5).map(i =>
      `<li class="text-sm text-blue-600">• ${tipify(esc(i))}</li>`
    ).join('');
    const socialBadges = socials.map(s =>
      `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="text-xs border border-slate-200 px-2.5 py-1 rounded-full hover:bg-slate-50 transition-colors font-medium">${esc(s.platform)} <span class="text-slate-400 font-normal">${esc(s.handle)}</span></a>`
    ).join('');
    detail = `<div class="mt-3 space-y-3">
      <div>
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Social profiles</div>
        <div class="flex flex-wrap gap-1.5">${socialBadges || '<span class="text-sm text-slate-400">No social profiles found on homepage</span>'}</div>
      </div>
      <div class="border border-slate-100 rounded-lg p-3 bg-slate-50/50">
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Email infrastructure</div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="bg-white rounded-lg p-2 border border-slate-100">
            <div class="text-sm font-bold ${em.has_mx ? 'text-green-600' : 'text-orange-500'}">${em.has_mx ? '✓' : '✗'}</div>
            <div class="text-xs text-slate-400 mt-0.5">MX record</div>
          </div>
          <div class="bg-white rounded-lg p-2 border border-slate-100">
            <div class="text-sm font-bold ${em.has_spf ? 'text-green-600' : 'text-orange-500'}">${em.has_spf ? '✓' : '✗'}</div>
            <div class="text-xs text-slate-400 mt-0.5">SPF</div>
          </div>
          <div class="bg-white rounded-lg p-2 border border-slate-100">
            <div class="text-sm font-bold ${em.has_dmarc ? (em.dmarc_policy === 'reject' ? 'text-green-600' : 'text-yellow-600') : 'text-orange-500'}">${em.has_dmarc ? (em.dmarc_policy ?? '?') : '✗'}</div>
            <div class="text-xs text-slate-400 mt-0.5">DMARC</div>
          </div>
        </div>
      </div>
      ${brand.has_knowledge_panel !== undefined ? `<div class="flex items-center gap-2 text-sm">
        <span class="${brand.has_knowledge_panel ? 'text-green-600' : 'text-slate-400'}">${brand.has_knowledge_panel ? '✓ Google Knowledge Panel found' : '✗ No Google Knowledge Panel'}</span>
      </div>` : ''}
      ${brand.ddg_abstract ? `<div class="text-sm text-slate-500 italic border-l-2 border-blue-200 pl-3">${esc(brand.ddg_abstract.slice(0, 220))}${brand.ddg_abstract.length > 220 ? '…' : ''}</div>` : ''}
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'site_intel' && data) {
    const hosting = data.hosting;
    const dns = data.dns ?? {};
    const tp = data.third_party ?? {};
    const issues = (data.issues ?? []).slice(0, 4).map(i =>
      `<li class="text-sm text-blue-600">• ${tipify(esc(i))}</li>`
    ).join('');

    const tpCats = Object.entries(tp.categories ?? {}).map(([cat, domains]) =>
      `<span class="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full border border-slate-200">${esc(cat)} (${Array.isArray(domains) ? domains.length : 0})</span>`
    ).join('');

    detail = `<div class="mt-3 space-y-3">
      <div class="grid grid-cols-2 gap-2">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Hosting provider</div>
          <div class="text-sm font-semibold text-slate-700">${hosting?.org_label ? esc(hosting.org_label) : hosting?.org ? esc(hosting.org) : '—'}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Server location</div>
          <div class="text-sm font-semibold text-slate-700">${hosting ? [hosting.city, hosting.country].filter(Boolean).map(esc).join(', ') : '—'}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 text-sm text-slate-600">
        ${data.ip ? `<span class="font-mono bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-lg text-xs">${esc(data.ip)}</span>` : ''}
        <span class="${dns.has_ipv6 ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50 text-slate-400 border-slate-200'} border text-xs px-2.5 py-1 rounded-full">IPv6 ${dns.has_ipv6 ? '✓' : '✗'}</span>
        ${(dns.ns ?? []).length ? `<span class="text-xs text-slate-500 border border-slate-200 px-2.5 py-1 rounded-full">NS: ${(dns.ns ?? []).slice(0,2).map(esc).join(', ')}</span>` : ''}
        ${hosting?.timezone ? `<span class="text-xs text-slate-400 border border-slate-200 px-2.5 py-1 rounded-full">${esc(hosting.timezone)}</span>` : ''}
      </div>
      ${tp.total_third_party_domains > 0 ? `<div>
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Third-party services (${tp.total_third_party_domains} domains)</div>
        <div class="flex flex-wrap gap-1.5">${tpCats}</div>
      </div>` : ''}
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'redirect_chain' && data) {
    const hops = data.hops ?? [];
    const statusColor = s => s < 300 ? 'bg-green-100 text-green-800 border-green-200' : s < 400 ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-orange-100 text-orange-800 border-orange-200';
    const hopChain = hops.map((h, i) => `
      ${i > 0 ? '<div class="flex justify-start pl-1 py-0.5"><div class="w-px h-4 bg-slate-200 ml-3.5"></div></div>' : ''}
      <div class="flex items-center gap-3">
        <span class="text-xs font-bold border ${statusColor(h.status)} px-2 py-1 rounded-lg shrink-0 min-w-[3rem] text-center">${h.status}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-mono text-slate-700 truncate">${esc(h.url)}</div>
          <div class="text-xs text-slate-400 mt-0.5">${h.duration_ms}ms</div>
        </div>
      </div>`).join('');
    const cleanBadge = data.is_clean
      ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✓ Clean redirect</span>'
      : `<span class="bg-amber-50 text-amber-700 border border-amber-200 text-xs px-2.5 py-1 rounded-full font-medium">⚠ ${data.chain_length} redirect hops</span>`;
    const issues = (data.issues ?? []).map(i => `<li class="text-sm text-blue-600">• ${tipify(esc(i))}</li>`).join('');
    detail = `<div class="mt-3 space-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        ${cleanBadge}
        ${data.has_https_redirect ? '<span class="bg-blue-50 text-blue-700 border border-blue-200 text-xs px-2.5 py-1 rounded-full">HTTPS redirect ✓</span>' : ''}
        ${data.has_www_change ? '<span class="bg-slate-100 text-slate-600 border border-slate-200 text-xs px-2.5 py-1 rounded-full">www normalisation</span>' : ''}
      </div>
      ${hops.length ? `<div class="space-y-0">${hopChain}</div>` : ''}
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'accessibility' && data) {
    const checks = data.wcag_checks ?? [];
    const passed = checks.filter(c => c.passed).length;
    const total = checks.length;
    const wcagPct = total ? Math.round(passed / total * 100) : 0;
    const wcagBar = wcagPct >= 80 ? 'bg-green-400' : wcagPct >= 60 ? 'bg-yellow-400' : 'bg-orange-400';
    const wcagText = wcagPct >= 80 ? 'text-green-700' : wcagPct >= 60 ? 'text-yellow-700' : 'text-orange-600';
    const dcwv = data.desktop_cwv;
    const dCwvChips = dcwv ? [
      dcwv.lcp_s != null && scoreVitals(dcwv.lcp_s, 2.5, 4, 'LCP desktop', dcwv.lcp_s.toFixed(1) + 's'),
      dcwv.cls != null && scoreVitals(dcwv.cls, 0.1, 0.25, 'CLS desktop', dcwv.cls.toFixed(3)),
      dcwv.fcp_s != null && scoreVitals(dcwv.fcp_s, 1.8, 3, 'FCP desktop', dcwv.fcp_s.toFixed(1) + 's'),
    ].filter(Boolean).join('') : '';
    const checkList = checks.slice(0, 8).map(c =>
      `<div class="flex items-start gap-2 text-sm py-1 border-t border-slate-100 first:border-t-0">
        <span class="${c.passed ? 'text-green-600' : 'text-orange-500'} shrink-0 font-semibold mt-0.5">${c.passed ? '✓' : '✗'}</span>
        <span class="${c.passed ? 'text-slate-500' : 'text-slate-700'} flex-1">${esc(c.rule)}${c.detail ? ` — <span class="text-blue-600">${esc(c.detail)}</span>` : ''}</span>
        <span class="text-xs text-slate-300 shrink-0">${c.level}</span>
      </div>`
    ).join('');
    const issues = (data.issues ?? []).slice(0, 4).map(i => `<li class="text-sm text-blue-600">• ${tipify(esc(i))}</li>`).join('');
    detail = `<div class="mt-3 space-y-3">
      <div class="flex items-center gap-3">
        <div class="flex-1 bg-slate-100 rounded-full h-2.5">
          <div class="${wcagBar} h-2.5 rounded-full" style="width:${wcagPct}%"></div>
        </div>
        <span class="text-base font-bold ${wcagText} shrink-0">${passed}/${total}</span>
        <span class="text-sm text-slate-400 shrink-0">WCAG checks</span>
      </div>
      ${dcwv ? `<div class="grid grid-cols-2 gap-2">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Desktop performance</div>
          <div class="text-base font-bold ${dcwv.performance >= 90 ? 'text-green-700' : dcwv.performance >= 50 ? 'text-yellow-700' : 'text-orange-600'}">${dcwv.performance}/100</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Accessibility score</div>
          <div class="text-base font-bold ${dcwv.accessibility_score >= 90 ? 'text-green-700' : dcwv.accessibility_score >= 70 ? 'text-yellow-700' : 'text-orange-600'}">${dcwv.accessibility_score}/100</div>
        </div>
      </div>` : ''}
      <div class="flex flex-wrap gap-1.5">
        ${data.has_skip_link ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✓ Skip link</span>' : '<span class="bg-slate-100 text-slate-500 border border-slate-200 text-xs px-2.5 py-1 rounded-full">✗ No skip link</span>'}
        ${data.has_aria_landmarks ? '<span class="bg-green-50 text-green-700 border border-green-200 text-xs px-2.5 py-1 rounded-full font-medium">✓ ARIA landmarks</span>' : '<span class="bg-slate-100 text-slate-500 border border-slate-200 text-xs px-2.5 py-1 rounded-full">✗ No ARIA landmarks</span>'}
      </div>
      ${dCwvChips ? `<div class="flex flex-wrap gap-2">${dCwvChips}</div>` : ''}
      <div class="border border-slate-100 rounded-lg p-3 bg-slate-50/50">${checkList}</div>
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'security_audit' && data) {
    const gradeColor = (g) => {
      if (!g || g === 'N/A') return 'text-slate-400 bg-slate-100 border-slate-200';
      if (g.startsWith('A')) return 'text-green-700 bg-green-50 border-green-200';
      if (g.startsWith('B')) return 'text-blue-700 bg-blue-50 border-blue-200';
      if (g.startsWith('C')) return 'text-yellow-700 bg-yellow-50 border-yellow-200';
      return 'text-slate-600 bg-slate-100 border-slate-200';
    };
    const barColor = data.score >= 80 ? 'bg-green-400' : data.score >= 60 ? 'bg-blue-400' : data.score >= 40 ? 'bg-yellow-400' : 'bg-slate-300';

    const allTests   = data.tests ?? [];
    const failed     = allTests.filter(t => !t.passed);
    const passed     = allTests.filter(t =>  t.passed);

    const severityMeta = {
      critical: { label: 'Critical',  dot: 'bg-orange-500',    text: 'text-orange-700',    badge: 'bg-orange-100 text-orange-700',    border: 'border-orange-200 bg-orange-50' },
      high:     { label: 'High',      dot: 'bg-orange-500', text: 'text-orange-700', badge: 'bg-orange-100 text-orange-700', border: 'border-orange-200 bg-orange-50' },
      medium:   { label: 'Medium',    dot: 'bg-yellow-500', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700', border: 'border-yellow-200 bg-yellow-50' },
      low:      { label: 'Low',       dot: 'bg-slate-400',  text: 'text-slate-600',  badge: 'bg-slate-100 text-slate-600',  border: 'border-slate-200 bg-slate-50' },
    };

    // Count by severity for the summary row
    const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    failed.forEach(t => { if (t.severity && t.severity !== 'pass') sevCounts[t.severity]++; });

    const sevSummary = Object.entries(sevCounts)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => {
        const m = severityMeta[s];
        return `<span class="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${m.badge}">
          <span class="w-1.5 h-1.5 rounded-full ${m.dot}"></span>${n} ${m.label}
        </span>`;
      }).join('');

    // Render each failed test as an expanded card
    const failedCards = failed.map(t => {
      const m = severityMeta[t.severity] ?? severityMeta.low;
      const pts = t.score_modifier < 0 ? `<span class="ml-auto shrink-0 text-[11px] font-semibold ${m.text}">${t.score_modifier} pts</span>` : '';
      const desc = t.description ? `<p class="text-xs text-slate-600 mt-1 leading-relaxed">${esc(t.description)}</p>` : '';
      const rec  = t.recommendation ? `<div class="mt-2 pt-2 border-t border-slate-200">
          <span class="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">How to fix</span>
          <p class="text-xs text-slate-700 mt-0.5 leading-relaxed">${esc(t.recommendation)}</p>
        </div>` : '';
      return `<div class="rounded-lg border ${m.border} p-3">
        <div class="flex items-start gap-2">
          <span class="w-2 h-2 rounded-full ${m.dot} mt-1 shrink-0"></span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-slate-800">${esc(t.name)}</span>
              <span class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${m.badge}">${m.label}</span>
              ${pts}
            </div>
            ${desc}
            ${rec}
          </div>
        </div>
      </div>`;
    }).join('');

    // Render passing tests as verbose cards showing what was measured + why it matters
    const passedCards = passed.map(t => {
      const det = t.detail
        ? `<div class="text-[11px] font-mono text-green-800 bg-green-50 border border-green-100 rounded px-2 py-1 mt-1 break-all leading-relaxed">${esc(t.detail)}</div>`
        : '';
      const desc = t.description
        ? `<p class="text-[11px] text-slate-500 mt-1 leading-relaxed">${esc(t.description)}</p>`
        : '';
      return `<div class="flex items-start gap-2 border border-green-100 bg-green-50/40 rounded-lg p-2.5">
        <span class="text-green-500 font-bold text-sm mt-0.5 shrink-0">✓</span>
        <div class="flex-1 min-w-0">
          <span class="text-xs font-semibold text-slate-700">${esc(t.name)}</span>
          ${det}
          ${desc}
        </div>
      </div>`;
    }).join('');

    // Gaps that this scan cannot detect — always relevant, especially for perfect scores
    const scanGaps = failed.length === 0 ? `<div class="mt-1 border border-amber-100 bg-amber-50/60 rounded-lg p-3">
      <div class="text-[11px] font-semibold text-amber-800 mb-1.5">Potential gaps not covered by this header scan</div>
      <ul class="space-y-1 text-[11px] text-amber-700 leading-relaxed list-disc list-inside">
        <li>Login-flow cookies — session &amp; auth cookies set post-login are not visible on the homepage</li>
        <li>API endpoints — only the root page was analysed; API routes may have different headers</li>
        <li>Third-party JS supply chain — even with SRI, first-party code can still carry vulnerabilities</li>
        <li>Browser fingerprinting &amp; timing side-channels (e.g. Spectre) are not detectable via HTTP headers</li>
        <li>OAuth / popup flows — Cross-Origin-Opener-Policy can silently break these; test login popups manually</li>
      </ul>
    </div>` : '';

    // Auto-open the passing section when all tests pass; collapsed when some failed
    const autoOpen = failed.length === 0 ? 'open' : '';

    detail = `<div class="mt-3 space-y-3">
      <!-- Grade + score bar -->
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-xl font-bold border-2 px-3 py-1 rounded-xl ${gradeColor(data.grade)}">${esc(data.grade)}</span>
        <div class="flex-1 min-w-32">
          <div class="flex items-center gap-2 mb-1">
            <div class="flex-1 bg-slate-100 rounded-full h-2.5">
              <div class="${barColor} h-2.5 rounded-full transition-all" style="width:${data.score}%"></div>
            </div>
            <span class="text-sm font-bold text-slate-700 shrink-0">${data.score}/100</span>
          </div>
          <div class="text-xs text-slate-400">${data.tests_passed} of ${data.tests_quantity} checks passed · Mozilla Observatory</div>
        </div>
      </div>

      <!-- Severity summary pills or all-pass banner -->
      ${sevSummary
        ? `<div class="flex flex-wrap gap-1.5">${sevSummary}</div>`
        : `<div class="flex items-center gap-2 text-xs text-green-700 font-medium bg-green-50 border border-green-100 rounded-lg px-3 py-2">
            <span class="text-base">🏆</span>All ${passed.length} security controls passed
          </div>`}

      <!-- Failed tests with detail -->
      ${failedCards ? `<div class="space-y-2">${failedCards}</div>` : ''}

      <!-- Passing tests — verbose cards, auto-open when all pass -->
      ${passed.length > 0 ? `<details ${autoOpen} class="group">
        <summary class="cursor-pointer text-xs font-semibold text-slate-500 hover:text-slate-700 list-none flex items-center gap-1.5 select-none py-0.5">
          <span class="group-open:hidden">▸</span><span class="hidden group-open:inline">▾</span>
          ${passed.length} passing control${passed.length !== 1 ? 's' : ''} — what was measured &amp; why it matters
        </summary>
        <div class="mt-2 space-y-2">
          ${passedCards}
        </div>
      </details>` : ''}

      ${scanGaps}
    </div>`;

  } else if (d.module === 'ssl_cert' && data) {
    const daysLeft = data.days_remaining ?? -1;
    const isValid = data.is_valid;
    const daysKnown = daysLeft >= 0; // -1 = cert valid but expiry details unavailable
    const daysBarPct = daysKnown ? Math.min(100, Math.round(daysLeft / 365 * 100)) : 0;
    const daysBar = !isValid ? 'bg-orange-400' : daysLeft <= 30 ? 'bg-orange-400' : daysLeft <= 90 ? 'bg-yellow-400' : 'bg-green-400';
    const daysText = !isValid ? 'text-orange-600' : daysLeft <= 30 && daysKnown ? 'text-orange-600 font-bold' : daysLeft <= 90 && daysKnown ? 'text-yellow-700' : 'text-green-700';
    const statusMsg = !isValid ? (data.issues?.[0] || 'Certificate could not be verified') : !daysKnown ? 'Certificate valid — expiry details unavailable' : daysLeft <= 30 ? 'Expires very soon — renew immediately' : daysLeft <= 90 ? 'Expiring within 90 days — schedule renewal' : 'Certificate valid and healthy';
    detail = `<div class="mt-3 space-y-3">
      ${isValid && daysKnown ? `<div class="flex items-center gap-3">
        <div class="flex-1 bg-slate-100 rounded-full h-2.5">
          <div class="${daysBar} h-2.5 rounded-full" style="width:${daysBarPct}%"></div>
        </div>
        <span class="text-base font-bold ${daysText} shrink-0">${daysLeft}d</span>
        <span class="text-sm text-slate-400 shrink-0">remaining</span>
      </div>` : ''}
      <div class="grid grid-cols-2 gap-2">
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Issued by</div>
          <div class="text-sm font-semibold text-slate-700">${esc(data.issuer || 'Unknown')}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Status</div>
          <div class="text-sm font-semibold ${isValid ? 'text-green-700' : 'text-orange-600'}">${isValid ? '✓ Valid' : '✗ Invalid'}</div>
        </div>
        ${data.valid_from ? `<div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Valid from</div>
          <div class="text-sm font-medium text-slate-700">${esc(data.valid_from)}</div>
        </div>` : ''}
        ${data.valid_to ? `<div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Expires</div>
          <div class="text-sm font-medium ${daysText}">${esc(data.valid_to)}</div>
        </div>` : ''}
      </div>
      <div class="text-sm ${daysText}">${esc(statusMsg)}</div>
    </div>`;

  } else if (d.module === 'domain_intel' && data) {
    const emailPct = data.email_security_score ?? 0;
    const emailBar = emailPct >= 90 ? 'bg-green-400' : emailPct >= 55 ? 'bg-yellow-400' : 'bg-orange-400';
    const emailText = emailPct >= 90 ? 'text-green-700' : emailPct >= 55 ? 'text-yellow-700' : 'text-orange-600';
    const expiryColor = data.days_until_expiry != null && data.days_until_expiry < 60 ? 'text-orange-600 font-semibold' : 'text-slate-700';
    const dkimList = (data.dkim_selectors_found ?? []).join(', ') || '—';
    const hasDkim = (data.dkim_selectors_found ?? []).length > 0;
    const statusBadges = (data.domain_status ?? []).slice(0, 3).map(s =>
      `<span class="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full border border-slate-200">${esc(s)}</span>`
    ).join('');
    const issues = (data.issues ?? []).slice(0, 4).map(i =>
      `<li class="text-sm text-blue-600">• ${tipify(esc(i))}</li>`
    ).join('');
    detail = `<div class="mt-3 space-y-3">
      <div class="grid grid-cols-2 gap-2">
        ${data.registrar ? `<div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Registrar</div>
          <div class="text-sm font-semibold text-slate-700">${esc(data.registrar)}</div>
        </div>` : ''}
        ${data.expiry_date ? `<div class="bg-slate-50 rounded-lg p-3">
          <div class="text-xs text-slate-400 mb-1">Domain expiry</div>
          <div class="text-sm font-semibold ${expiryColor}">${esc(data.expiry_date.slice(0,10))}</div>
          <div class="text-xs text-slate-400 mt-0.5">${data.days_until_expiry}d remaining</div>
        </div>` : ''}
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span class="${data.dnssec ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-100 text-slate-500 border-slate-200'} border text-xs px-2.5 py-1 rounded-full font-medium">DNSSEC ${data.dnssec ? '✓' : '✗'}</span>
        ${statusBadges}
      </div>
      <div class="border border-slate-100 rounded-lg p-3 bg-slate-50/50">
        <div class="flex items-center justify-between mb-2.5">
          <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Email security</span>
          <div class="flex items-center gap-2">
            <div class="w-24 bg-slate-200 rounded-full h-1.5"><div class="${emailBar} h-1.5 rounded-full" style="width:${emailPct}%"></div></div>
            <span class="text-sm font-semibold ${emailText}">${emailPct}/100</span>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="bg-white rounded-lg p-2 border border-slate-100">
            <div class="text-sm font-bold ${data.spf ? 'text-green-600' : 'text-orange-500'}">${data.spf ? '✓' : '✗'}</div>
            <div class="text-xs text-slate-400 mt-0.5">SPF</div>
          </div>
          <div class="bg-white rounded-lg p-2 border border-slate-100">
            <div class="text-sm font-bold ${data.dmarc ? 'text-green-600' : 'text-orange-500'}">${data.dmarc ? '✓' : '✗'}</div>
            <div class="text-xs text-slate-400 mt-0.5">DMARC</div>
          </div>
          <div class="bg-white rounded-lg p-2 border border-slate-100">
            <div class="text-sm font-bold ${hasDkim ? 'text-green-600' : 'text-orange-500'}">${hasDkim ? '✓' : '✗'}</div>
            <div class="text-xs text-slate-400 mt-0.5">DKIM</div>
          </div>
        </div>
        ${hasDkim ? `<div class="text-xs font-mono text-slate-400 mt-2">Selectors: ${esc(dkimList)}</div>` : ''}
        ${data.spf ? `<div class="text-xs font-mono text-slate-400 mt-1 truncate">SPF: ${esc(data.spf)}</div>` : ''}
      </div>
      <ul class="space-y-1">${issues}</ul>
    </div>`;

  } else if (d.module === 'crux' && data) {
    if (!data.has_data) {
      const msg = (data.issues ?? [])[0] ?? 'No CrUX data available';
      detail = `<div class="mt-2 text-xs text-slate-400 italic">${esc(msg)}</div>`;
    } else {
      const perfScore = data.performance_score ?? 0;
      const perfColor = perfScore >= 80 ? 'bg-green-400' : perfScore >= 50 ? 'bg-yellow-400' : 'bg-orange-400';
      const perfText  = perfScore >= 80 ? 'text-green-700' : perfScore >= 50 ? 'text-yellow-700' : 'text-orange-700';

      const METRICS = [
        { key: 'lcp',  abbr: 'LCP',  name: 'Largest Contentful Paint', desc: 'How fast the main content loads',          good: 2500, poor: 4000, fmt: v => (v/1000).toFixed(2)+'s', target: '≤2.5s good · ≤4s needs improvement' },
        { key: 'cls',  abbr: 'CLS',  name: 'Cumulative Layout Shift',  desc: 'Visual stability — how much the page jumps', good: 0.1,  poor: 0.25, fmt: v => Number(v).toFixed(3),    target: '≤0.1 good · ≤0.25 needs improvement' },
        { key: 'inp',  abbr: 'INP',  name: 'Interaction to Next Paint', desc: 'Responsiveness to clicks and taps',         good: 200,  poor: 500,  fmt: v => v+'ms',                  target: '≤200ms good · ≤500ms needs improvement' },
        { key: 'fcp',  abbr: 'FCP',  name: 'First Contentful Paint',   desc: 'When text or images first appear',           good: 1800, poor: 3000, fmt: v => (v/1000).toFixed(2)+'s', target: '≤1.8s good · ≤3s needs improvement' },
        { key: 'ttfb', abbr: 'TTFB', name: 'Time to First Byte',       desc: 'Server response time',                       good: 800,  poor: 1800, fmt: v => v+'ms',                  target: '≤800ms good · ≤1.8s needs improvement' },
      ];

      const metricRows = METRICS.map(m => {
        const metric = data[m.key];
        if (!metric) return '';
        const val = Number(metric.p75);
        const isGood  = val <= m.good;
        const isPoor  = val > m.poor;
        const statusLabel = isGood ? 'Good' : isPoor ? 'Poor' : 'Needs Improvement';
        const statusColor = isGood ? 'text-green-700 bg-green-50 border-green-200'
                          : isPoor ? 'text-orange-700 bg-orange-50 border-orange-200'
                          :          'text-yellow-700 bg-yellow-50 border-yellow-200';
        const valColor = isGood ? 'text-green-700' : isPoor ? 'text-orange-600' : 'text-yellow-700';
        const good = metric.good_rate ?? 0;
        const ni   = metric.needs_improvement_rate ?? 0;
        const poor = metric.poor_rate ?? 0;
        return `
          <div class="py-2 border-t border-slate-100 first:border-t-0">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <span class="font-semibold text-sm text-slate-800">${m.abbr}</span>
                <span class="text-xs text-slate-500 ml-1.5">${m.name}</span>
                <div class="text-[11px] text-slate-400 mt-0.5">${m.desc}</div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-sm font-bold ${valColor}">${m.fmt(val)}</span>
                <span class="text-[10px] font-medium border rounded px-1.5 py-0.5 ${statusColor}">${statusLabel}</span>
              </div>
            </div>
            <div class="mt-1.5 flex rounded-full overflow-hidden h-1.5 bg-slate-100">
              <div class="bg-green-400 h-full" style="width:${good}%"></div>
              <div class="bg-yellow-400 h-full" style="width:${ni}%"></div>
              <div class="bg-orange-400 h-full" style="width:${poor}%"></div>
            </div>
            <div class="flex items-center gap-3 mt-1.5 text-xs text-slate-400 flex-wrap">
              <span><span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-1"></span>${good}% good</span>
              <span><span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1"></span>${ni}% needs improvement</span>
              <span><span class="inline-block w-2 h-2 rounded-full bg-orange-400 mr-1"></span>${poor}% poor</span>
              <span class="ml-auto text-slate-300">Target: ${m.target}</span>
            </div>
          </div>`;
      }).join('');

      detail = `<div class="mt-2 space-y-0">
        <div class="flex items-center gap-2 mb-2">
          <div class="flex-1 bg-slate-100 rounded-full h-2">
            <div class="${perfColor} h-2 rounded-full transition-all" style="width:${perfScore}%"></div>
          </div>
          <span class="text-sm font-bold ${perfText} w-16 text-right">${perfScore}/100</span>
        </div>
        <div class="text-xs text-slate-400 mb-3">Real Chrome user data · Mobile · 75th percentile · 28-day rolling window</div>
        ${metricRows}
      </div>`;
    }

  } else if (d.error) {
    detail = `<div class="mt-2 text-sm text-slate-400">${esc(d.error)}</div>`;
  }

  // Collapsible card: header toggles the detail body
  if (detail) {
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-1 cursor-pointer select-none card-collapse-toggle" onclick="toggleCardBody(this)">
        <span>${statusIcon}</span>
        <span class="font-semibold text-base">${moduleName(d.module)}</span>
        ${ms}
        <svg class="chevron w-4 h-4 text-slate-300 ml-1 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
      </div>
      <div class="card-body">${detail}</div>`;
  } else {
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-1">
        <span>${statusIcon}</span>
        <span class="font-semibold text-base">${moduleName(d.module)}</span>
        ${ms}
      </div>`;
  }

  // Left-border accent colour by status — instant visual scanning
  const statusBorderColor = { ok: '#4ade80', partial: '#fbbf24', failed: '#fb923c' };
  if (statusBorderColor[d.status]) {
    el.style.borderLeftWidth = '3px';
    el.style.borderLeftColor = statusBorderColor[d.status];
  }

  // Keep active category filter in sync during live streaming
  applyActiveCatFilter(el);
}

function wireCopyReport(data) {
  const btn = document.getElementById('copy-report-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const lines = [
      `GeoScore Audit — ${data.domain}`,
      `Date: ${new Date(data.created_at).toLocaleString()}`,
      '',
      `Overall: ${data.overall_score}/100  |  SEO: ${data.seo_score}/100  |  GEO·AI: ${data.geo_score}/100`,
      '',
    ];
    const tech = data.modules?.technical_seo?.data;
    if (tech) {
      lines.push('── Technical SEO ──');
      lines.push(`Score: ${tech.score}/100`);
      (tech.issues || []).forEach(i => lines.push(`  • ${i}`));
      if (tech.tech_stack?.cms) lines.push(`  CMS: ${tech.tech_stack.cms}`);
      if (tech.security_headers) lines.push(`  Security headers: ${tech.security_headers.score}/100`);
      lines.push('');
    }
    const geo = data.modules?.geo_predicted?.data;
    if (geo && geo.is_reliable !== false) {
      lines.push('── GEO / AI Citation Prediction ──');
      lines.push(`Citation rate: ${Math.round((geo.citation_rate || 0) * 100)}%  |  Avg confidence: ${Math.round((geo.avg_confidence || 0) * 100)}%`);
      (geo.queries || []).forEach(q => lines.push(`  ${q.cited ? '✓' : '✗'} ${q.query}`));
      lines.push('');
    }
    const kw = data.modules?.keywords?.data;
    if (kw?.keywords?.length && kw.is_reliable !== false) {
      lines.push('── Top Keywords ──');
      kw.keywords.slice(0, 15).forEach(k => lines.push(`  [${k.intent}] ${k.keyword}${k.geo_potential ? ' ✦' : ''}`));
      lines.push('');
    }
    const onPage = data.modules?.on_page_seo?.data;
    if (onPage?.page_speed) {
      lines.push('── Core Web Vitals (Mobile) ──');
      const ps = onPage.page_speed;
      lines.push(`  Performance: ${ps.performance}/100  |  Accessibility: ${ps.accessibility}/100`);
      if (ps.lcp_s) lines.push(`  LCP: ${ps.lcp_s}s  CLS: ${ps.cls ?? '—'}  FCP: ${ps.fcp_s}s`);
      lines.push('');
    }
    const offPage = data.modules?.off_page_seo?.data;
    if (offPage) {
      lines.push('── Off-Page SEO ──');
      if (offPage.social_profiles?.length) lines.push(`  Social: ${offPage.social_profiles.map(s => s.platform).join(', ')}`);
      const em = offPage.email_security;
      if (em) lines.push(`  Email security: MX ${em.has_mx ? '✓' : '✗'}  SPF ${em.has_spf ? '✓' : '✗'}  DMARC ${em.has_dmarc ? em.dmarc_policy ?? '✓' : '✗'}`);
      lines.push('');
    }
    const siteIntel = data.modules?.site_intel?.data;
    if (siteIntel) {
      lines.push('── Site Intelligence ──');
      if (siteIntel.hosting?.org) lines.push(`  Host: ${siteIntel.hosting.org_label || siteIntel.hosting.org} (${[siteIntel.hosting.city, siteIntel.hosting.country].filter(Boolean).join(', ')})`);
      if (siteIntel.ip) lines.push(`  IP: ${siteIntel.ip}`);
      if ((siteIntel.fonts?.google_fonts ?? []).length) lines.push(`  Fonts: ${siteIntel.fonts.google_fonts.join(', ')}`);
      if (siteIntel.carbon) lines.push(`  Carbon: ${siteIntel.carbon.grams_per_view}g CO₂/view (rating ${siteIntel.carbon.rating})`);
      lines.push('');
    }
    const redirect = data.modules?.redirect_chain?.data;
    if (redirect) {
      lines.push('── Redirect Chain ──');
      lines.push(`  Hops: ${redirect.chain_length}  |  HTTPS: ${redirect.has_https_redirect ? '✓' : '✗'}  |  Clean: ${redirect.is_clean ? '✓' : '✗'}`);
      (redirect.issues ?? []).forEach(i => lines.push(`  • ${i}`));
      lines.push('');
    }
    const access = data.modules?.accessibility?.data;
    if (access) {
      lines.push('── Accessibility ──');
      lines.push(`  WCAG score: ${access.score}/100`);
      if (access.desktop_cwv) lines.push(`  Desktop Perf: ${access.desktop_cwv.performance}/100  A11y: ${access.desktop_cwv.accessibility_score}/100`);
      (access.issues ?? []).slice(0, 3).forEach(i => lines.push(`  • ${i}`));
      lines.push('');
    }
    const recs = data.modules?.recommendations?.data;
    if (recs?.length) {
      lines.push('── Recommendations ──');
      recs.forEach((r, i) => lines.push(`  ${i + 1}. ${r.title} (Impact ${r.impact}/5, Effort ${r.effort}/5)`));
      lines.push('');
    }
    lines.push(`Generated by GeoScore — https://geoscoreapp.pages.dev/?d=${data.domain}`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy report'; }, 2000);
    });
  }, { once: true });
}

function renderRecommendations(recs) {
  if (!recs?.length) return;
  const existing = document.getElementById('recs-section');
  if (existing) existing.remove();

  recMap.clear();
  const slice = recs.slice(0, 8);
  slice.forEach((r, i) => recMap.set(i, r));

  const el = document.createElement('div');
  el.id = 'recs-section';
  el.className = 'bg-white rounded-xl border border-orange-200 p-4 fade-in mt-3';
  el.style.order = cardOrder('recs-section');
  el.style.display = '';
  const doneSet = getRecDoneSet(currentDomain);
  const effortBadge = (n) => {
    const map = { 1: 'bg-green-50 text-green-700', 2: 'bg-green-50 text-green-700', 3: 'bg-amber-50 text-amber-700', 4: 'bg-orange-50 text-orange-700', 5: 'bg-orange-50 text-orange-700' };
    return `<span class="text-xs ${map[n] || 'bg-slate-100 text-slate-600'} px-2 py-0.5 rounded-full border border-slate-200">${effortTime(n)}</span>`;
  };
  el.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="font-semibold text-sm">📋 Top Recommendations</div>
      <span class="text-xs text-slate-400" id="recs-done-count"></span>
    </div>
    <ol class="space-y-2.5" id="recs-list">
      ${slice.map((r, i) => {
        const isDone = doneSet.has(r.title);
        return `
        <li class="text-sm border border-slate-100 rounded-xl p-3.5 transition-opacity ${isDone ? 'rec-done' : ''}" id="rec-item-${i}">
          <div class="flex items-start gap-3">
            <input type="checkbox" class="rec-checkbox mt-0.5 w-4 h-4 shrink-0 rounded accent-green-600 cursor-pointer"
              data-title="${esc(r.title)}" ${isDone ? 'checked' : ''}>
            <div class="flex-1 min-w-0">
              <div class="font-medium rec-body">${esc(r.title)}</div>
              <div class="text-xs text-slate-500 mt-0.5 leading-relaxed">${esc(r.why)}</div>
              <div class="flex gap-2 mt-2 items-center flex-wrap">
                <span class="text-xs ${r.impact >= 4 ? 'bg-orange-50 text-orange-700 border-orange-200' : r.impact >= 3 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200'} px-2 py-0.5 rounded-full border font-medium">Impact ${r.impact}/5</span>
                ${effortBadge(r.effort)}
                <button class="text-xs text-blue-500 hover:text-blue-700 underline ml-auto transition-colors" data-action="toggle-fix" data-rec-index="${i}">How to fix ▾</button>
              </div>
              <div class="hidden mt-3 what-to-do"></div>
            </div>
          </div>
        </li>`;
      }).join('')}
    </ol>`;
  // Update done count
  const updateRecsCount = () => {
    const total = slice.length;
    const done = document.querySelectorAll('#recs-list .rec-checkbox:checked').length;
    const countEl = document.getElementById('recs-done-count');
    if (countEl) countEl.textContent = done > 0 ? `${done}/${total} done` : `${total} action${total !== 1 ? 's' : ''}`;
  };
  updateRecsCount();
  // Keep count live as user checks boxes
  document.getElementById('recs-list')?.addEventListener('change', updateRecsCount);
  document.getElementById('modules').appendChild(el);
}

async function toggleWhatToDo(btn) {
  const li = btn.closest('li');
  const box = li && li.querySelector('.what-to-do');
  if (!box) return;

  const isHidden = box.classList.toggle('hidden');
  btn.textContent = isHidden ? 'How to fix ▾' : 'How to fix ▴';
  if (isHidden || box.dataset.loaded) return;

  const rec = recMap.get(Number(btn.dataset.recIndex));
  if (!rec) return;

  // First open — fetch AI-generated fix guide
  box.dataset.loaded = '1';
  const fixStart = Date.now();
  const fixTimerEl = document.createElement('div');
  fixTimerEl.className = 'text-xs text-slate-400 italic flex items-center gap-2';
  fixTimerEl.innerHTML = 'Generating fix guide… <span class="font-mono text-blue-400">0s</span>';
  box.innerHTML = '';
  box.appendChild(fixTimerEl);
  const fixTimerInterval = setInterval(() => {
    const s = fixTimerEl.querySelector('span');
    if (s) s.textContent = fmtSecs(Date.now() - fixStart);
  }, 1000);

  try {
    const res = await fetch(`${API}/api/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: currentDomain,
        title: rec.title,
        why: rec.why,
        template_id: rec.template_id,
      }),
    });
    if (!res.ok || !res.body) throw new Error('Fix guide unavailable');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    box.innerHTML = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try { raw += JSON.parse(payload).response ?? ''; } catch { /* skip */ }
      }
      box.innerHTML = renderFixMarkdown(raw);
    }
    clearInterval(fixTimerInterval);
    box.innerHTML = renderFixMarkdown(raw) +
      `<div class="text-[10px] text-slate-300 mt-2 text-right">Generated in ${fmtSecs(Date.now() - fixStart)}</div>`;
  } catch {
    clearInterval(fixTimerInterval);
    box.innerHTML = '<div class="text-xs text-blue-500">Could not load fix guide. Try again.</div>';
    delete box.dataset.loaded;
  }
}

function renderFixMarkdown(text) {
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = escaped
    // code blocks ```...```
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) =>
      `<pre class="bg-slate-900 text-green-300 rounded p-2 my-2 text-xs overflow-x-auto whitespace-pre-wrap">${c.trim()}</pre>`)
    // inline code `...`
    .replace(/`([^`]+)`/g, '<code class="bg-slate-100 text-pink-700 px-1 rounded text-xs">$1</code>')
    // bold **...**
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // headings ## ...
    .replace(/^#{1,3} (.+)$/gm, '<div class="font-semibold text-slate-700 mt-3 mb-1">$1</div>')
    // numbered list items "1. ..."
    .replace(/^(\d+)\. (.+)$/gm, (_, n, content) =>
      `<div class="flex gap-2 mt-2"><span class="shrink-0 font-bold text-blue-600 w-4">${n}.</span><span>${content}</span></div>`)
    // bullet list items "- ..."
    .replace(/^[-•] (.+)$/gm, '<div class="flex gap-2 mt-1 ml-4"><span class="shrink-0 text-slate-400">•</span><span>$1</span></div>')
    // blank lines → spacing
    .replace(/\n{2,}/g, '<div class="mt-2"></div>')
    .replace(/\n/g, ' ');

  return `<div class="text-xs text-slate-700 leading-relaxed space-y-0.5">${html}</div>`;
}

function appendError(msg, temporary = false) {
  const el = document.createElement('div');
  el.className = `${temporary ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-blue-50 border-blue-200 text-blue-700'} border rounded-xl p-4 text-sm fade-in`;
  el.textContent = msg;
  document.getElementById('modules').appendChild(el);
  if (temporary) setTimeout(() => el.remove(), 5000);
}

// ── Chat ────────────────────────────────────────────────────────────────────

function enableChat() {
  document.getElementById('chat-section').classList.remove('hidden');
  const main = document.getElementById('main-content');
  if (main) main.style.paddingBottom = '152px';
}

function clearChat() {
  const msgs = document.getElementById('chat-messages');
  if (msgs) { msgs.innerHTML = ''; msgs.style.maxHeight = '0'; }
  const clearBtn = document.getElementById('chat-clear');
  if (clearBtn) { clearBtn.classList.add('hidden'); clearBtn.classList.remove('flex'); }
  const sugg = document.getElementById('chat-suggestions');
  if (sugg) sugg.classList.remove('hidden');
}

const chatInput = document.getElementById('chat-input');
const chatSend  = document.getElementById('chat-send');
const chatClear = document.getElementById('chat-clear');

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
if (chatClear) chatClear.addEventListener('click', clearChat);

document.querySelectorAll('.chat-suggestion').forEach(btn => {
  btn.addEventListener('click', () => {
    chatInput.value = btn.textContent.trim();
    chatInput.focus();
    sendChat();
  });
});

async function sendChat() {
  const q = chatInput.value.trim();
  if (!q || !currentAuditId) return;
  chatInput.value = '';
  chatSend.disabled = true;

  appendChatMessage('user', q);
  const assistantEl = appendChatMessage('assistant', '…');
  const chatStart = Date.now();
  const chatTimerInterval = setInterval(() => {
    if (!assistantEl.textContent || assistantEl.textContent === '…') {
      assistantEl.textContent = `… ${fmtSecs(Date.now() - chatStart)}`;
    }
  }, 1000);

  try {
    const res = await fetch(`${API}/api/chat/${currentAuditId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, session_id: sessionId }),
    });

    if (!res.ok) { clearInterval(chatTimerInterval); assistantEl.textContent = 'Error getting response.'; return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    assistantEl.textContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.response) { buffer += data.response; assistantEl.textContent = buffer; }
        } catch { /* skip */ }
      }
    }
    clearInterval(chatTimerInterval);
    document.getElementById('chat-messages').scrollTop = 9999;
  } catch {
    clearInterval(chatTimerInterval);
    assistantEl.textContent = 'Network error. Please try again.';
  } finally {
    chatSend.disabled = false;
  }
}

function appendChatMessage(role, text) {
  const msgs = document.getElementById('chat-messages');
  if (!msgs.children.length) {
    msgs.style.maxHeight = '220px';
    // Show clear button and hide suggestion chips once conversation begins
    const clearBtn = document.getElementById('chat-clear');
    if (clearBtn) { clearBtn.classList.remove('hidden'); clearBtn.classList.add('flex'); }
    document.getElementById('chat-suggestions')?.classList.add('hidden');
  }
  const el = document.createElement('div');
  el.className = role === 'user'
    ? 'text-sm bg-blue-50 text-blue-900 px-3 py-2 rounded-xl self-end ml-8'
    : 'text-sm bg-slate-100 text-slate-800 px-3 py-2 rounded-xl mr-8';
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = 9999;
  return el;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Decode HTML entities from server-returned strings (e.g. &amp; → &) before rendering in the UI.
// The server returns raw HTML values extracted from <title> / meta tags that are already HTML-encoded.
// Without this, esc('&amp;') would double-encode to &amp;amp;.
function decodeHTMLEntities(str) {
  const el = document.createElement('textarea');
  el.innerHTML = String(str ?? '');
  return el.value;
}

const TECH_TIPS = {
  'HSTS': 'HTTP Strict Transport Security — forces browsers to always use HTTPS',
  'CSP': 'Content Security Policy — controls which scripts and resources the browser can load',
  'X-Frame-Options': 'Prevents your page from being embedded in iframes (clickjacking protection)',
  'canonical': 'Tells search engines which URL is the preferred version of a page',
  'DMARC': 'Email authentication policy that prevents spoofing of your domain in emails',
  'SPF': 'Sender Policy Framework — verifies which servers can send email for your domain',
  'MX': 'Mail Exchange — DNS record that routes email to your mail server',
  'robots\\.txt': 'File that tells search engine crawlers which pages to skip',
  'sitemap\\.xml': 'Map of all your URLs — helps search engines discover your content',
  'JSON-LD': "Google's preferred structured data format, embedded in a script tag",
  'WebP': 'Modern image format — 25–34% smaller than JPEG/PNG with same quality',
  'AVIF': 'Next-gen image format — even smaller file sizes than WebP',
  'alt text': 'Text description of an image, used by screen readers and search engines',
  'WCAG': 'Web Content Accessibility Guidelines — international standards for accessible websites',
  'GEO': 'Generative Engine Optimization — optimizing content to appear in AI-generated answers',
  'E-E-A-T': 'Experience, Expertise, Authoritativeness, Trustworthiness — Google\'s quality signals',
  'llms\\.txt': 'A file that helps AI models like ChatGPT and Claude understand your site',
  'Open Graph': 'Meta tags that control how your page looks when shared on social media',
  'schema markup': 'Structured data code that helps search engines understand your content',
  'backlinks': 'Links from other websites to yours — a major Google ranking factor',
  'SERP': 'Search Engine Results Page — what users see after a Google search',
  'CLS': 'Cumulative Layout Shift — measures unexpected layout shifts while the page loads',
  'LCP': 'Largest Contentful Paint — time for the main content block to appear on screen',
  'FCP': 'First Contentful Paint — time until the browser first shows any content',
  'TTFB': 'Time to First Byte — how fast the server starts sending a response',
  'IPv6': 'Latest internet protocol version with a much larger address space than IPv4',
  'CDN': 'Content Delivery Network — servers around the world that serve your site faster',
  'hreflang': 'HTML attribute telling search engines which language and region a page targets',
  'Core Web Vitals': "Google's key page experience metrics that affect search rankings",
};

function tipify(escapedHtml) {
  let result = escapedHtml;
  for (const [rawTerm, desc] of Object.entries(TECH_TIPS)) {
    const re = new RegExp(`\\b(${rawTerm})\\b`, 'gi');
    result = result.replace(re, `<abbr class="tech-tip" title="${desc}">$1</abbr>`);
  }
  return result;
}

function renderSummaryBullets(text) {
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let bullets;
  if (lines.some(l => /^[-•*]|\d+\./.test(l))) {
    bullets = lines.map(l => l.replace(/^[-•*]\s*|\d+\.\s*/, '')).filter(Boolean);
  } else {
    bullets = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 10);
  }
  return `<ul class="space-y-2">${bullets.map(b =>
    `<li class="flex gap-2 text-sm leading-relaxed"><span class="text-blue-400 shrink-0 mt-0.5">•</span><span class="text-blue-900">${tipify(esc(b))}</span></li>`
  ).join('')}</ul>`;
}

function scoreVitals(value, good, poor, label, display) {
  const color = value <= good ? 'text-green-600 border-green-200 bg-green-50'
              : value <= poor ? 'text-amber-600 border-amber-200 bg-amber-50'
              : 'text-blue-600 border-blue-200 bg-blue-50';
  return `<span class="text-[10px] border px-1.5 py-0.5 rounded-full font-medium ${color}">${label}: ${display}</span>`;
}

function moduleName(key) {
  const names = {
    technical_seo:        '⚙️ Technical SEO',
    schema_audit:         '🗂️ Schema Markup',
    content_quality:      '📝 Content Quality',
    authority:            '🏛️ Domain Authority',
    geo_predicted:        '🤖 AI Visibility · Citation Prediction',
    recommendations:      '📋 Recommendations',
    keywords:             '🔑 Keyword Opportunities',
    on_page_seo:          '📄 On-Page SEO · Core Web Vitals',
    off_page_seo:         '🔗 Off-Page SEO · Social & Email',
    site_intel:           '🌐 Site Intelligence · Hosting & Fonts',
    redirect_chain:       '↪️ Redirect Chain Audit',
    accessibility:        '♿ Accessibility · WCAG Audit',
    security_audit:       '🛡️ Security Audit · Mozilla Observatory',
    ssl_cert:             '🔒 SSL Certificate',
    domain_intel:         '🔍 Domain Intel · WHOIS & Email Security',
    crux:                 '📊 Core Web Vitals · Real-User Data (CrUX)',
    ai_content_insights:  '🧠 AI Content Insights',
    cache:                'Cache',
  };
  return names[key] || key.replace(/_/g, ' ');
}

// ── Computed sections rendered after full audit data arrives ────────────────

function renderComputedSections(data) {
  // Guard: only run once per audit (cache-hit + complete both call renderFullAudit)
  if (computedSectionsRendered) return;
  computedSectionsRendered = true;

  const mods = data.modules ?? {};
  const techData = mods.technical_seo?.data;
  const schemaData = mods.schema_audit?.data;
  const authData = mods.authority?.data;
  const contentData = mods.content_quality?.data;
  const offPageData = mods.off_page_seo?.data;
  const onPageData = mods.on_page_seo?.data;
  const geoData = mods.geo_predicted?.data;
  const kwData = mods.keywords?.data;

  const addCard = (id, category, html) => {
    if (document.getElementById(id)) return;
    const el = document.createElement('div');
    el.id = id;
    el.className = 'bg-white rounded-xl border border-slate-200 p-5 fade-in';
    el.dataset.category = category;
    el.innerHTML = html;
    el.style.order = cardOrder(id);
    document.getElementById('modules').appendChild(el);
    applyActiveCatFilter(el);
  };

  // ── SERP Preview ──────────────────────────────────────────────────────────
  if (techData?.page_meta) {
    const pm = techData.page_meta;
    // Decode HTML entities from server-extracted meta values (e.g. &amp; → &) before rendering.
    // The server returns raw HTML-encoded strings; esc() re-encodes them, so we decode first.
    const serpTitle = decodeHTMLEntities(pm.title || pm.og_title || data.domain);
    const serpDesc = decodeHTMLEntities(pm.description || pm.og_description || 'No meta description found.');
    const serpUrl = pm.canonical_url || `https://${data.domain}/`;
    const titleLen = (pm.title || '').length;
    const descLen = (pm.description || '').length;
    const titleColor = titleLen > 70 ? 'text-blue-600' : titleLen < 30 ? 'text-amber-600' : 'text-green-700';
    const descColor = descLen > 170 ? 'text-blue-600' : descLen < 100 ? 'text-amber-600' : 'text-green-700';

    addCard('card-serp-preview', 'previews', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">🔍 SERP Snippet Preview</div>
        <div class="flex gap-3 text-[10px]">
          <span class="${titleColor}">Title: ${titleLen} chars</span>
          <span class="${descColor}">Desc: ${descLen} chars</span>
        </div>
      </div>
      <div class="border border-slate-200 rounded-xl p-4 bg-white max-w-2xl font-sans">
        <div class="text-xs text-slate-500 mb-1 truncate">${esc(serpUrl)}</div>
        <div class="text-blue-700 text-lg leading-snug hover:underline cursor-pointer font-normal" style="font-family: arial, sans-serif; font-size: 20px; color: #1a0dab; line-clamp: 1; overflow: hidden; white-space: nowrap;">${esc(serpTitle)}</div>
        <div class="text-slate-700 text-sm mt-1 leading-snug" style="font-family: arial, sans-serif; font-size: 14px; color: #4d5156; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${esc(serpDesc)}</div>
      </div>
      ${titleLen > 70 ? '<p class="text-xs text-blue-500 mt-2">⚠ Title too long — Google will truncate it at ~60 chars</p>' : ''}
      ${descLen > 170 ? '<p class="text-xs text-blue-500 mt-1">⚠ Description too long — will be cut off in SERP</p>' : ''}
      ${descLen < 100 ? '<p class="text-xs text-amber-600 mt-1">⚠ Description too short — aim for 100–170 chars</p>' : ''}
    `);
  }

  // ── Social Card Preview ───────────────────────────────────────────────────
  if (techData?.page_meta) {
    const pm = techData.page_meta;
    const cardTitle = decodeHTMLEntities(pm.og_title || pm.title || data.domain);
    const cardDesc = decodeHTMLEntities(pm.og_description || pm.description || 'No description');
    const domainDisplay = data.domain.toUpperCase();
    let ogImageUrl = pm.og_image || '';
    if (ogImageUrl && !ogImageUrl.startsWith('http')) {
      ogImageUrl = `https://${data.domain}${ogImageUrl.startsWith('/') ? '' : '/'}${ogImageUrl}`;
    }

    const imgPlaceholder = (h, label) =>
      `<div class="h-${h} bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-slate-400 text-xs">${label}</div>`;
    const imgTag = (h, url) =>
      url ? `<div class="bg-slate-100 h-${h} overflow-hidden"><img src="${esc(url)}" alt="OG preview" class="w-full h-full object-cover og-preview-img"></div>`
           : imgPlaceholder(h, 'No og:image set');

    // OG completeness audit
    const ogFields = [
      { tag: 'og:title',       val: pm.og_title },
      { tag: 'og:description', val: pm.og_description },
      { tag: 'og:image',       val: pm.og_image },
      { tag: 'og:type',        val: pm.og_type },
      { tag: 'og:site_name',   val: pm.og_site_name },
    ];
    const ogAuditRows = ogFields.map(({ tag, val }) => {
      const ok = !!val;
      const dot = ok ? '<span class="text-green-500">●</span>' : '<span class="text-amber-400">●</span>';
      const value = val ? `<span class="text-slate-500 font-mono truncate max-w-[180px] inline-block align-bottom">${esc(String(val).slice(0, 60))}${val.length > 60 ? '…' : ''}</span>` : `<span class="text-amber-600">not set</span>`;
      return `<div class="flex items-center gap-2 py-0.5">${dot}<span class="text-slate-600 w-28 shrink-0">${tag}</span>${value}</div>`;
    }).join('');

    // Social profiles
    const profiles = pm.social_profiles ?? [];
    const PLATFORM_LABELS = { 'twitter': '𝕏', 'x.com': '𝕏', 'facebook': 'f', 'linkedin': 'in', 'instagram': 'ig', 'youtube': '▶', 'tiktok': '♪', 'github': '⌥', 'pinterest': 'P', 'reddit': 'r/' };
    const profileChips = profiles.map(url => {
      const host = url.match(/https?:\/\/(?:www\.)?([^/]+)/i)?.[1]?.toLowerCase() ?? '';
      const key = Object.keys(PLATFORM_LABELS).find(k => host.includes(k));
      const label = key ? PLATFORM_LABELS[key] : host.split('.')[0];
      return `<a href="${esc(url)}" target="_blank" rel="noopener" class="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded-full font-medium transition-colors">${esc(label)} ${esc(host.replace('www.','').split('/')[0])}</a>`;
    }).join('');

    // lang badge
    const langBadge = pm.lang
      ? `<span class="text-[10px] bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">lang="${esc(pm.lang)}" ✓</span>`
      : `<span class="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">lang attribute missing</span>`;

    addCard('card-social-preview', 'previews', `
      <div class="font-semibold text-sm mb-3">📱 Social Share &amp; Meta Tags</div>
      <div class="flex gap-3 flex-wrap mb-3">
        <div class="flex-1 min-w-52 max-w-xs">
          <div class="text-[10px] text-slate-400 mb-1.5 font-medium">𝕏 Twitter / X Card</div>
          <div class="border border-slate-200 rounded-xl overflow-hidden bg-white">
            ${imgTag(36, ogImageUrl)}
            <div class="p-3">
              <div class="text-[11px] text-slate-500 uppercase tracking-wide">${esc(domainDisplay)}</div>
              <div class="text-sm font-semibold text-slate-900 leading-snug mt-0.5 truncate">${esc(cardTitle)}</div>
              <div class="text-xs text-slate-500 mt-0.5 line-clamp-2">${esc(cardDesc)}</div>
            </div>
          </div>
        </div>
        <div class="flex-1 min-w-52 max-w-xs">
          <div class="text-[10px] text-slate-400 mb-1.5 font-medium">LinkedIn Post</div>
          <div class="border border-slate-200 rounded-xl overflow-hidden bg-white">
            ${imgTag(32, ogImageUrl)}
            <div class="p-3 bg-slate-50 border-t border-slate-100">
              <div class="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">${esc(cardTitle)}</div>
              <div class="text-[11px] text-slate-500 mt-0.5">${esc(data.domain)}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="border border-slate-100 rounded-lg p-3 bg-slate-50 mb-3">
        <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Open Graph completeness</div>
        <div class="text-xs space-y-0">${ogAuditRows}</div>
      </div>
      ${profiles.length ? `<div class="mb-2"><div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Social profiles found</div><div class="flex flex-wrap gap-1.5">${profileChips}</div></div>` : '<div class="text-xs text-amber-600 mb-2">⚠ No social profile links detected — add links to your LinkedIn, Twitter/X, Facebook, etc.</div>'}
      ${(pm.article_published_time || pm.article_modified_time || pm.article_author) ? `
      <div class="border border-slate-100 rounded-lg p-3 bg-slate-50 mb-2">
        <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Article metadata</div>
        <div class="text-xs space-y-0.5">
          ${pm.article_published_time ? `<div class="flex items-center gap-2"><span class="text-green-500">●</span><span class="text-slate-500 w-28 shrink-0">Published</span><span class="text-slate-700 font-mono">${esc(new Date(pm.article_published_time).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}))}</span></div>` : ''}
          ${pm.article_modified_time ? `<div class="flex items-center gap-2"><span class="text-green-500">●</span><span class="text-slate-500 w-28 shrink-0">Last updated</span><span class="text-slate-700 font-mono">${esc(new Date(pm.article_modified_time).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}))}</span></div>` : ''}
          ${pm.article_author ? `<div class="flex items-center gap-2"><span class="text-green-500">●</span><span class="text-slate-500 w-28 shrink-0">Author</span><span class="text-slate-700">${esc(pm.article_author)}</span></div>` : ''}
        </div>
      </div>` : ''}
      <div class="flex items-center gap-2 flex-wrap mt-1">
        ${langBadge}
        ${pm.twitter_card ? `<span class="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">twitter:card = ${esc(pm.twitter_card)}</span>` : '<span class="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">twitter:card missing</span>'}
        ${pm.og_type ? `<span class="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">og:type = ${esc(pm.og_type)}</span>` : ''}
      </div>
    `);
  }

  // ── Structured Data Viewer ────────────────────────────────────────────────
  if (schemaData?.schemas_raw?.length) {
    const blocks = schemaData.schemas_raw.slice(0, 5);
    const blockHtml = blocks.map((schema, i) => {
      const formatted = JSON.stringify(schema, null, 2);
      const type = (schema['@type'] || 'Schema') + '';
      return `<details class="border border-slate-200 rounded-lg overflow-hidden">
        <summary class="px-3 py-2 bg-slate-50 hover:bg-slate-100 cursor-pointer text-xs font-medium flex items-center gap-2">
          <span class="text-blue-600">{ }</span> ${esc(type)}
        </summary>
        <pre class="text-[10px] bg-slate-900 text-green-300 p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap" style="max-height:200px">${esc(formatted)}</pre>
      </details>`;
    }).join('');
    addCard('card-structured-data', 'previews', `
      <div class="font-semibold text-sm mb-3">🔬 Structured Data Viewer</div>
      <div class="space-y-1.5">${blockHtml}</div>
      ${schemaData.schemas_raw.length > 5 ? `<div class="text-xs text-slate-400 mt-2">+ ${schemaData.schemas_raw.length - 5} more schema blocks</div>` : ''}
    `);
  }

  // ── E-E-A-T Scorecard ─────────────────────────────────────────────────────
  const eeat = computeEeat({ techData, schemaData, authData, contentData, offPageData, onPageData });
  addCard('card-eeat', 'geo', `
    <div class="font-semibold text-sm mb-3">🏅 E-E-A-T Scorecard
      <span class="text-xs text-slate-400 font-normal ml-2">Google quality evaluator signals</span>
    </div>
    <div class="space-y-2.5">
      ${renderEeatBar('Experience', 'E', eeat.experience, 'Content depth, FAQs, rich media, freshness signals')}
      ${renderEeatBar('Expertise', 'E', eeat.expertise, 'Schema completeness, author signals, content quality')}
      ${renderEeatBar('Authoritativeness', 'A', eeat.authority, 'Domain age, Wikipedia/Wikidata, backlinks, social presence')}
      ${renderEeatBar('Trustworthiness', 'T', eeat.trustworthiness, 'HTTPS, security headers, DMARC/SPF, canonical, privacy policy')}
    </div>
    <div class="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
      <div class="flex-1 bg-slate-100 rounded-full h-2">
        <div class="${eeat.total >= 70 ? 'bg-green-500' : eeat.total >= 40 ? 'bg-yellow-400' : 'bg-blue-400'} h-2 rounded-full transition-all" style="width:${eeat.total}%"></div>
      </div>
      <span class="text-sm font-bold ${eeat.total >= 70 ? 'text-green-600' : eeat.total >= 40 ? 'text-yellow-600' : 'text-blue-500'}">${eeat.total}/100</span>
      <span class="text-xs text-slate-400">Overall E-E-A-T</span>
    </div>
  `);

  // ── SSL Certificate ───────────────────────────────────────────────────────
  // Skip if the richer streaming card (module-ssl_cert) already exists in the DOM —
  // renderSection() for ssl_cert produces a more detailed card with a validity progress bar.
  const sslData = mods.ssl_cert?.data;
  if (sslData && !document.getElementById('module-ssl_cert')) {
    const daysLeft = sslData.days_remaining ?? 0;
    const isValid = sslData.is_valid;
    const statusColor = !isValid ? 'text-slate-600 bg-slate-100 border-slate-200'
      : daysLeft <= 30 ? 'text-orange-600 bg-orange-50 border-orange-200'
      : daysLeft <= 90 ? 'text-amber-600 bg-amber-50 border-amber-200'
      : 'text-green-700 bg-green-50 border-green-200';
    const statusIcon = !isValid ? '⚪' : daysLeft <= 30 ? '🔴' : daysLeft <= 90 ? '🟡' : '🟢';
    addCard('card-ssl-cert', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">🔒 SSL Certificate</div>
        <span class="text-xs px-2 py-1 rounded-full border font-medium ${statusColor}">${statusIcon} ${isValid ? `${daysLeft} days left` : 'Not found'}</span>
      </div>
      ${isValid ? `
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">Issuer</div>
          <div class="font-medium text-slate-800 truncate">${esc(sslData.issuer || 'Unknown')}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">Expires</div>
          <div class="font-medium text-slate-800">${esc(sslData.valid_to || '—')}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">Valid from</div>
          <div class="font-medium text-slate-800">${esc(sslData.valid_from || '—')}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">Days remaining</div>
          <div class="font-semibold ${daysLeft <= 30 ? 'text-orange-600' : daysLeft <= 90 ? 'text-amber-600' : 'text-green-700'}">${daysLeft}</div>
        </div>
      </div>
      ` : `<div class="text-xs text-slate-600 bg-slate-50 rounded-lg p-3">${esc(sslData.issues?.[0] || 'SSL certificate could not be verified')}</div>`}
    `);
  }

  // ── Readability ───────────────────────────────────────────────────────────
  const readability = contentData?.readability;
  if (readability && contentData?.word_count >= 30) {
    const ease = readability.flesch_ease ?? 0;
    const easeColor = ease >= 70 ? 'text-green-700' : ease >= 50 ? 'text-amber-600' : 'text-orange-600';
    const easeBg = ease >= 70 ? 'bg-green-50 border-green-200' : ease >= 50 ? 'bg-amber-50 border-amber-200' : 'bg-orange-50 border-orange-200';
    const easeWidth = ease;
    const easeBarColor = ease >= 70 ? 'bg-green-500' : ease >= 50 ? 'bg-yellow-400' : 'bg-blue-400';
    addCard('card-readability', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">📖 Readability Score</div>
        <span class="text-xs px-2 py-1 rounded-full border font-medium ${easeColor} ${easeBg}">${esc(readability.grade_label || '—')}</span>
      </div>
      <div class="mb-3">
        <div class="flex justify-between text-xs text-slate-500 mb-1">
          <span>Flesch Reading Ease</span><span class="font-semibold ${easeColor}">${ease}/100</span>
        </div>
        <div class="bg-slate-100 rounded-full h-2">
          <div class="${easeBarColor} h-2 rounded-full transition-all" style="width:${easeWidth}%"></div>
        </div>
        <div class="flex justify-between text-[10px] text-slate-400 mt-0.5"><span>Very Difficult</span><span>Very Easy</span></div>
      </div>
      <div class="grid grid-cols-3 gap-2 text-xs">
        <div class="bg-slate-50 rounded-lg p-2 text-center">
          <div class="font-semibold text-slate-800">${readability.grade_level ?? '—'}</div>
          <div class="text-slate-400 text-[10px]">Grade level</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2 text-center">
          <div class="font-semibold text-slate-800">${readability.avg_words_per_sentence ?? '—'}</div>
          <div class="text-slate-400 text-[10px]">Words/sentence</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2 text-center">
          <div class="font-semibold text-slate-800">${readability.reading_time_min ?? '—'} min</div>
          <div class="text-slate-400 text-[10px]">Read time</div>
        </div>
      </div>
      ${(readability.grade_level ?? 0) >= 12 ? `<p class="mt-2 text-xs text-slate-400">Technical or B2B content naturally scores lower on readability scales — AI engines still index complex content well.</p>` : ''}
    `);
  }

  // ── Technology Stack (Wappalyzer-style grouped categories) ───────────────
  if (techData?.tech_stack) {
    const ts = techData.tech_stack;
    const versions = ts.versions ?? {};
    const siData = mods.site_intel?.data;
    const sslData = mods.ssl_cert?.data;

    const paasLabel = ts.paas || siData?.hosting?.org_label || null;

    const sslCA = (() => {
      const issuer = sslData?.issuer ?? '';
      if (!issuer) return null;
      if (/digicert/i.test(issuer)) return 'DigiCert';
      if (/letsencrypt|let's encrypt/i.test(issuer)) return "Let's Encrypt";
      if (/comodo|sectigo/i.test(issuer)) return 'Sectigo';
      if (/globalsign/i.test(issuer)) return 'GlobalSign';
      if (/entrust/i.test(issuer)) return 'Entrust';
      if (/godaddy/i.test(issuer)) return 'GoDaddy';
      if (/amazon/i.test(issuer)) return 'Amazon';
      if (/google/i.test(issuer)) return 'Google Trust Services';
      if (/cloudflare/i.test(issuer)) return 'Cloudflare';
      return issuer.split(',')[0]?.replace(/CN=|O=/g, '').trim() || null;
    })();

    const mx0 = siData?.dns?.mx?.[0]?.exchange ?? '';
    const mxEmailProvider = mx0.includes('google') || mx0.includes('gmail') ? 'Google Workspace'
      : mx0.includes('outlook') || mx0.includes('microsoft') ? 'Microsoft 365'
      : mx0.includes('protonmail') ? 'ProtonMail'
      : mx0.includes('mailgun') ? 'Mailgun'
      : mx0.includes('sendgrid') ? 'SendGrid'
      : mx0.includes('mxroute') ? 'MXroute'
      : mx0.includes('zoho') ? 'Zoho Mail'
      : mx0 ? mx0.split('.').slice(-2, -1)[0] || null : null;

    // Chip with optional version badge
    const chip = (label, color) => {
      const ver = versions[label];
      const verBadge = ver ? `<span class="ml-1 text-[9px] opacity-60 font-mono">v${esc(ver)}</span>` : '';
      return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-${color}-50 text-${color}-700 border border-${color}-200">${esc(label)}${verBadge}</span>`;
    };

    // Section header for visual grouping
    const sectionHeader = (label) =>
      `<div class="text-[10px] font-semibold text-slate-300 uppercase tracking-wider pt-3 pb-1 first:pt-0">${label}</div>`;

    const row = (label, items, color) => items.length === 0 ? '' :
      `<div class="flex items-start gap-3 py-1.5 border-b border-slate-50 last:border-0">
        <div class="text-[11px] text-slate-400 w-32 shrink-0 pt-0.5">${label}</div>
        <div class="flex flex-wrap gap-1">${items.map(i => chip(i, color)).join('')}</div>
      </div>`;

    const totalThirdParty = siData?.third_party?.total_third_party_domains ?? 0;
    let totalDetected = 0;

    // Count all detected technologies
    const allGroups = [
      ts.web_server, ts.cdn, paasLabel, ts.backend_language,
      ts.cms, ts.ecommerce,
      ...(ts.frameworks ?? []), ...(ts.js_libraries ?? []), ts.css_framework,
      ...(ts.analytics ?? []), ...(ts.tag_manager ?? []), ...(ts.heatmaps ?? []), ...(ts.ab_testing ?? []),
      ts.chat, ...(ts.forms ?? []), ...(ts.video ?? []), ...(ts.maps ?? []),
      ...(ts.payments ?? []), ...(ts.email_marketing ?? []), ...(ts.monitoring ?? []),
      ts.cookie_consent, sslCA, mxEmailProvider,
    ];
    totalDetected = allGroups.filter(Boolean).length;

    const infrastructureRows = [
      row('Web server',   ts.web_server ? [ts.web_server] : [],         'slate'),
      row('CDN',          ts.cdn ? [ts.cdn] : [],                       'blue'),
      row('PaaS / Host',  paasLabel ? [paasLabel] : [],                 'orange'),
      row('Backend',      ts.backend_language ? [ts.backend_language] : [], 'zinc'),
    ].join('');

    const platformRows = [
      row('CMS',          ts.cms ? [ts.cms] : [],                       'purple'),
      row('E-commerce',   ts.ecommerce ? [ts.ecommerce] : [],           'pink'),
    ].join('');

    const frontendRows = [
      row('JS Framework', ts.frameworks ?? [],                          'indigo'),
      row('JS Libraries', ts.js_libraries ?? [],                        'violet'),
      row('CSS Framework',ts.css_framework ? [ts.css_framework] : [],   'fuchsia'),
    ].join('');

    const trackingRows = [
      row('Analytics',    ts.analytics ?? [],                           'green'),
      row('Tag manager',  ts.tag_manager ?? [],                         'teal'),
      row('Heatmaps',     ts.heatmaps ?? [],                            'cyan'),
      row('A/B testing',  ts.ab_testing ?? [],                         'sky'),
    ].join('');

    const engagementRows = [
      row('Live chat',    ts.chat ? [ts.chat] : [],                     'emerald'),
      row('Forms',        ts.forms ?? [],                               'lime'),
      row('Video',        ts.video ?? [],                               'red'),
      row('Maps',         ts.maps ?? [],                                'rose'),
    ].join('');

    const businessRows = [
      row('Payments',     ts.payments ?? [],                            'amber'),
      row('Email mktg',   ts.email_marketing ?? [],                    'yellow'),
      row('Monitoring',   ts.monitoring ?? [],                          'slate'),
    ].join('');

    const complianceRows = [
      row('Cookie consent', ts.cookie_consent ? [ts.cookie_consent] : [], 'amber'),
      row('SSL/TLS CA',   sslCA ? [sslCA] : [],                        'emerald'),
      row('Email host',   mxEmailProvider ? [mxEmailProvider] : [],    'sky'),
    ].join('');

    const buildSection = (header, content) => content.trim()
      ? `${sectionHeader(header)}${content}` : '';

    const allSections = [
      buildSection('Infrastructure', infrastructureRows),
      buildSection('Platform', platformRows),
      buildSection('Frontend', frontendRows),
      buildSection('Tracking & Analytics', trackingRows),
      buildSection('Engagement', engagementRows),
      buildSection('Business', businessRows),
      buildSection('Compliance & Trust', complianceRows),
    ].filter(Boolean).join('');

    addCard('card-tech-stack', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">⚙️ Technology Stack</div>
        <div class="flex items-center gap-2">
          ${totalDetected > 0 ? `<span class="text-[11px] font-medium text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full">${totalDetected} detected</span>` : ''}
          ${totalThirdParty > 0 ? `<span class="text-[11px] text-slate-400">${totalThirdParty} 3rd-party domains</span>` : ''}
        </div>
      </div>
      ${allSections || '<div class="text-xs text-slate-400 py-2">No technology fingerprints detected</div>'}
      <div class="mt-3 pt-2.5 border-t border-slate-100 flex items-center gap-3 flex-wrap text-[11px] text-slate-400">
        ${techData.page_weight_kb > 0 ? `<span>Page size: <span class="font-medium ${techData.page_weight_kb > 500 ? 'text-amber-600' : 'text-slate-600'}">${techData.page_weight_kb} KB</span>${techData.page_weight_kb > 500 ? ' — consider optimising' : ''}</span>` : ''}
        ${(() => { const rbs = techData.render_blocking_scripts ?? 0; return rbs > 0 ? `<span class="text-amber-600 font-medium">⚡ ${rbs} render-blocking script${rbs > 1 ? 's' : ''} — add async/defer</span>` : rbs === 0 && techData.page_weight_kb > 0 ? '<span class="text-green-600">✓ No render-blocking scripts</span>' : ''; })()}
        ${totalThirdParty > 5 ? `<span class="text-amber-600">⚠ ${totalThirdParty} 3rd-party domains — review for privacy impact</span>` : totalThirdParty > 0 ? `<span>${totalThirdParty} 3rd-party domains</span>` : ''}
      </div>
    `);
  }

  // ── DNS & Network ─────────────────────────────────────────────────────────
  const siteIntelData = mods.site_intel?.data;
  if (siteIntelData?.dns) {
    const dns = siteIntelData.dns;
    const mxProvider = dns.mx?.[0]?.exchange
      ? (dns.mx[0].exchange.includes('google') ? 'Google Workspace'
        : dns.mx[0].exchange.includes('outlook') || dns.mx[0].exchange.includes('microsoft') ? 'Microsoft 365'
        : dns.mx[0].exchange.includes('protonmail') ? 'ProtonMail'
        : dns.mx[0].exchange.includes('mailgun') ? 'Mailgun'
        : dns.mx[0].exchange.split('.').slice(-2, -1)[0] || 'Custom')
      : 'None';
    const nsProvider = dns.ns?.[0]
      ? (dns.ns[0].includes('cloudflare') ? 'Cloudflare'
        : dns.ns[0].includes('awsdns') ? 'AWS Route 53'
        : dns.ns[0].includes('google') ? 'Google Cloud DNS'
        : dns.ns[0].includes('azure') ? 'Azure DNS'
        : dns.ns[0].split('.').slice(-2, -1)[0] || 'Custom')
      : 'Unknown';
    addCard('card-dns', 'site_intel', `
      <div class="font-semibold text-sm mb-3">🌐 DNS & Network</div>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">IP Address</div>
          <div class="font-medium text-slate-800 font-mono">${esc(dns.a?.[0] || siteIntelData.ip || '—')}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">IPv6</div>
          <div class="font-medium ${dns.has_ipv6 ? 'text-green-700' : 'text-slate-400'}">${dns.has_ipv6 ? '✓ Enabled' : '✗ Not detected'}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">Name servers</div>
          <div class="font-medium text-slate-800">${esc(nsProvider)}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-slate-400 mb-0.5">Email provider</div>
          <div class="font-medium text-slate-800">${esc(mxProvider)}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5 col-span-2">
          <div class="text-slate-400 mb-0.5">TXT records</div>
          <div class="font-medium text-slate-800">${dns.txt_count} records${dns.txt_count > 5 ? ' — complex DNS zone' : ''}</div>
        </div>
      </div>
    `);
  }

  // ── Font Performance ──────────────────────────────────────────────────────
  if (siteIntelData?.fonts) {
    const fonts = siteIntelData.fonts;
    const allFonts = [
      ...(fonts.google_fonts ?? []).map(f => ({ name: f, source: 'Google Fonts', color: 'blue' })),
      ...(fonts.bunny_fonts ?? []).map(f => ({ name: f, source: 'Bunny Fonts', color: 'purple' })),
      ...(fonts.custom_fonts ?? []).map(f => ({ name: f, source: 'Custom', color: 'slate' })),
      ...(fonts.adobe_fonts ? [{ name: 'Adobe Fonts', source: 'Adobe', color: 'red' }] : []),
    ];
    const perfNote = fonts.google_fonts.length > 0
      ? '<div class="text-xs text-amber-600 mt-2">⚠ Google Fonts add external DNS lookups — consider self-hosting or <a href="https://bunny.net/fonts" target="_blank" class="underline">Bunny Fonts</a> for privacy & speed.</div>'
      : fonts.system_only
      ? '<div class="text-xs text-green-700 mt-2">✓ System fonts only — zero external font requests, fastest possible load</div>'
      : '';
    addCard('card-fonts', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">🔤 Font Performance</div>
        <span class="text-xs text-slate-400">${fonts.total_font_requests} font request${fonts.total_font_requests !== 1 ? 's' : ''}</span>
      </div>
      ${allFonts.length ? `<div class="flex flex-wrap gap-1.5 mb-2">${allFonts.map(f =>
        `<span class="inline-flex flex-col px-2 py-1 rounded-lg bg-${f.color}-50 border border-${f.color}-200 text-[10px]">
          <span class="font-medium text-${f.color}-800">${esc(f.name)}</span>
          <span class="text-${f.color}-500">${f.source}</span>
        </span>`).join('')}</div>`
      : '<div class="text-xs text-slate-400 mb-2">No web fonts detected</div>'}
      ${perfNote}
    `);
  }

  // ── Robots.txt Detail ─────────────────────────────────────────────────────
  const robotsSummary = techData?.robots_summary;
  if (robotsSummary?.user_agent_count > 0 || robotsSummary?.preview) {
    addCard('card-robots', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">🤖 Robots.txt</div>
        <div class="flex gap-3 text-[10px] text-slate-500">
          <span>${robotsSummary.user_agent_count} user-agent${robotsSummary.user_agent_count !== 1 ? 's' : ''}</span>
          <span>${robotsSummary.disallow_count} disallow rule${robotsSummary.disallow_count !== 1 ? 's' : ''}</span>
          ${robotsSummary.has_sitemap_ref ? '<span class="text-green-600">✓ Sitemap referenced</span>' : '<span class="text-amber-600">⚠ No sitemap ref</span>'}
        </div>
      </div>
      ${robotsSummary.preview ? `<pre class="text-[10px] bg-slate-900 text-green-300 p-3 rounded-lg overflow-x-auto leading-relaxed whitespace-pre-wrap" style="max-height:200px">${esc(robotsSummary.preview)}</pre>` : '<div class="text-xs text-orange-500">robots.txt not found or empty</div>'}
    `);
  }

  // ── llms.txt Generator ───────────────────────────────────────────────────
  const vertical = geoData?.vertical || kwData?.vertical || 'business';
  const keywords = (kwData?.keywords ?? []).slice(0, 12).map(k => k.keyword);
  const schemas = schemaData?.schemas_found ?? [];
  addCard('card-llms-gen', 'previews', `
    <div class="font-semibold text-sm mb-2">📄 llms.txt Auto-Generator
      <span class="text-xs text-slate-400 font-normal ml-2">AI-written for ${esc(data.domain)}</span>
    </div>
    <div class="text-xs text-slate-500 mb-3">
      llms.txt helps ChatGPT, Claude, Perplexity, and Gemini discover and correctly understand your site's content.
      ${techData?.llms_txt_present
        ? '<span class="text-green-600 font-medium">✓ llms.txt already exists on your site</span>'
        : '<span class="text-amber-600 font-medium">⚠ No llms.txt found — generate one below</span>'
      }
    </div>
    <div id="llms-gen-output" class="hidden mb-3 border border-slate-200 rounded-lg bg-slate-900 p-3">
      <pre id="llms-gen-text" class="text-xs text-green-300 whitespace-pre-wrap leading-relaxed overflow-x-auto" style="max-height:300px"></pre>
    </div>
    <div class="flex gap-2 flex-wrap">
      <button id="llms-gen-btn" class="text-xs bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors font-medium"
        data-domain="${esc(data.domain)}" data-vertical="${esc(vertical)}"
        data-keywords="${esc(keywords.join(','))}" data-schemas="${esc(schemas.join(','))}">
        ✨ Generate llms.txt
      </button>
      ${techData?.llms_txt_present ? `<button id="llms-view-btn" class="text-xs border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors" data-domain="${esc(data.domain)}">👁 View existing</button>` : ''}
      <button id="llms-copy-btn" class="hidden text-xs border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors">Copy</button>
    </div>
  `);

  // ── AI Content Insights ───────────────────────────────────────────────────
  // renderSection() has no specific handler for ai_content_insights, so it creates a title-only
  // stub (module-ai_content_insights). Replace it with the rich computed cards below.
  const aiStub = document.getElementById('module-ai_content_insights');
  if (aiStub) aiStub.remove();

  const aiData = data.modules?.ai_content_insights?.data;
  if (aiData) {
    const aiScore = aiData.ai_visibility_score ?? 0;
    const aiScoreColor = aiScore >= 70 ? 'green' : aiScore >= 40 ? 'amber' : 'red';
    const trustAvg = Math.round(((aiData.trust_scores?.topical_relevance ?? 0) + (aiData.trust_scores?.subject_expertise ?? 0) + (aiData.trust_scores?.credibility ?? 0)) / 3);

    addCard('card-ai-business', 'ai', `
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="font-semibold text-sm">🧠 AI Content Insights</div>
          <div class="text-xs text-slate-400 mt-0.5">${esc(aiData.business_context?.industry_niche || 'General')}</div>
        </div>
        <div class="flex flex-col items-center">
          <div class="text-2xl font-bold text-${aiScoreColor}-600">${aiScore}</div>
          <div class="text-[9px] text-slate-400 uppercase tracking-wide">AI Visibility</div>
        </div>
      </div>
      <div class="bg-slate-50 rounded-lg p-3 mb-3">
        <div class="text-xs font-medium text-slate-600 mb-1">Business Description</div>
        <div class="text-xs text-slate-700 leading-relaxed">${esc(aiData.business_context?.description || '—')}</div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-[10px] text-slate-500 mb-1">Target Audience</div>
          <div class="text-xs font-medium text-slate-700">${esc(aiData.business_context?.target_audience || '—')}</div>
        </div>
        <div class="bg-slate-50 rounded-lg p-2.5">
          <div class="text-[10px] text-slate-500 mb-1">Content Summary</div>
          <div class="text-xs text-slate-700 leading-relaxed">${esc((aiData.content_analysis?.summary || '—').slice(0, 120))}</div>
        </div>
      </div>
    `);

    const strengths = aiData.content_analysis?.strengths ?? [];
    const weaknesses = aiData.content_analysis?.weaknesses ?? [];
    addCard('card-ai-content', 'ai', `
      <div class="font-semibold text-sm mb-3">📊 Content Analysis</div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <div class="text-xs font-medium text-green-700 mb-2 flex items-center gap-1"><span>✓</span> Strengths</div>
          ${strengths.length ? `<ul class="space-y-1.5">${strengths.map(s => `<li class="text-xs text-slate-600 flex gap-1.5"><span class="text-green-500 shrink-0 mt-0.5">●</span>${esc(s)}</li>`).join('')}</ul>` : '<div class="text-xs text-slate-400">None identified</div>'}
        </div>
        <div>
          <div class="text-xs font-medium text-orange-700 mb-2 flex items-center gap-1"><span>✗</span> Weaknesses</div>
          ${weaknesses.length ? `<ul class="space-y-1.5">${weaknesses.map(w => `<li class="text-xs text-slate-600 flex gap-1.5"><span class="text-orange-400 shrink-0 mt-0.5">●</span>${esc(w)}</li>`).join('')}</ul>` : '<div class="text-xs text-slate-400">None identified</div>'}
        </div>
      </div>
    `);

    const ts = aiData.trust_scores ?? {};
    addCard('card-ai-trust', 'ai', `
      <div class="font-semibold text-sm mb-3">🏆 Trust & Authority Scores</div>
      <div class="space-y-2.5 mb-3">
        ${[['Topical Relevance', ts.topical_relevance ?? 0], ['Subject Expertise', ts.subject_expertise ?? 0], ['Credibility', ts.credibility ?? 0]].map(([label, val]) => {
          const pct = val;
          const col = pct >= 70 ? 'green' : pct >= 40 ? 'amber' : 'red';
          return `<div>
            <div class="flex justify-between text-xs mb-1"><span class="text-slate-600">${label}</span><span class="font-medium text-${col}-600">${pct}/100</span></div>
            <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full bg-${col}-500 rounded-full" style="width:${pct}%"></div></div>
          </div>`;
        }).join('')}
      </div>
      <div class="text-xs text-slate-500 italic leading-relaxed">${esc(ts.summary || '')}</div>
    `);

    const fr = aiData.freshness ?? {};
    const frColor = (fr.score ?? 0) >= 70 ? 'green' : (fr.score ?? 0) >= 40 ? 'amber' : 'red';
    addCard('card-ai-freshness', 'ai', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">🕐 Content Freshness</div>
        <span class="text-lg font-bold text-${frColor}-600">${fr.score ?? 0}/100</span>
      </div>
      <div class="h-2 bg-slate-100 rounded-full overflow-hidden mb-3">
        <div class="h-full bg-${frColor}-500 rounded-full" style="width:${fr.score ?? 0}%"></div>
      </div>
      ${(fr.signals ?? []).length ? `<div class="flex flex-wrap gap-1.5 mb-2">${(fr.signals).map(s => `<span class="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="text-xs text-slate-500 italic">${esc(fr.summary || '')}</div>
    `);

    const opp = aiData.opportunities ?? {};
    const wins = opp.quick_wins ?? [];
    addCard('card-ai-opportunities', 'ai', `
      <div class="font-semibold text-sm mb-2">💡 AI Opportunities</div>
      <div class="text-xs text-slate-600 leading-relaxed mb-3">${esc(opp.summary || '')}</div>
      ${wins.length ? `
        <div class="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Quick Wins</div>
        <ul class="space-y-2">${wins.map((w, i) => `
          <li class="flex items-start gap-2 text-xs text-slate-700">
            <span class="shrink-0 w-4 h-4 rounded-full bg-blue-100 text-blue-700 text-[9px] font-bold flex items-center justify-center">${i + 1}</span>
            ${esc(w)}
          </li>`).join('')}
        </ul>` : ''}
    `);
  }

  // ── Heading Tags ──────────────────────────────────────────────────────────
  const h1Tags = techData?.h1_tags ?? [];
  const h2Tags = techData?.h2_tags ?? [];
  if (h1Tags.length > 0 || h2Tags.length > 0) {
    addCard('card-headings', 'seo', `
      <div class="font-semibold text-sm mb-3">📝 Heading Tags</div>
      <div class="space-y-3">
        <div>
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-xs font-bold bg-blue-600 text-white px-2 py-0.5 rounded">H1</span>
            <span class="text-xs text-slate-400">${h1Tags.length} tag${h1Tags.length !== 1 ? 's' : ''} ${h1Tags.length === 1 ? '✓' : h1Tags.length === 0 ? '⚠ Missing' : '⚠ Multiple'}</span>
          </div>
          <div class="space-y-1">${h1Tags.slice(0, 3).map(h => `<div class="text-xs bg-blue-50 border border-blue-100 text-blue-800 px-3 py-1.5 rounded-lg leading-snug">${esc(h)}</div>`).join('') || '<div class="text-xs text-slate-400">No H1 found</div>'}</div>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-xs font-bold bg-slate-600 text-white px-2 py-0.5 rounded">H2</span>
            <span class="text-xs text-slate-400">${h2Tags.length} tag${h2Tags.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="space-y-1">${h2Tags.slice(0, 5).map(h => `<div class="text-xs bg-slate-50 border border-slate-100 text-slate-700 px-3 py-1.5 rounded-lg leading-snug">${esc(h)}</div>`).join('') || '<div class="text-xs text-slate-400">No H2 found</div>'}
          ${h2Tags.length > 5 ? `<div class="text-xs text-slate-400">+${h2Tags.length - 5} more H2 tags</div>` : ''}</div>
        </div>
      </div>
    `);
  }

  // ── Image Alt Audit ───────────────────────────────────────────────────────
  const imgAudit = techData?.image_audit;
  if (imgAudit && imgAudit.total > 0) {
    const missingList = imgAudit.missing_alt_srcs ?? [];
    const altOk = imgAudit.missing_alt === 0;
    addCard('card-image-alt', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">🖼 Image Optimization</div>
        <span class="text-xs px-2 py-0.5 rounded-full ${altOk ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'} font-medium">
          ${imgAudit.total - imgAudit.missing_alt}/${imgAudit.total} have alt text
        </span>
      </div>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="bg-slate-50 rounded-lg p-2.5 text-center">
          <div class="text-lg font-bold text-slate-700">${imgAudit.total}</div>
          <div class="text-[10px] text-slate-400">Total Images</div>
        </div>
        <div class="bg-${imgAudit.missing_alt === 0 ? 'green' : 'red'}-50 rounded-lg p-2.5 text-center">
          <div class="text-lg font-bold text-${imgAudit.missing_alt === 0 ? 'green' : 'red'}-600">${imgAudit.missing_alt}</div>
          <div class="text-[10px] text-slate-400">Missing Alt</div>
        </div>
        <div class="bg-blue-50 rounded-lg p-2.5 text-center">
          <div class="text-lg font-bold text-blue-600">${imgAudit.modern_count}</div>
          <div class="text-[10px] text-slate-400">Modern (WebP/AVIF)</div>
        </div>
      </div>
      ${missingList.length ? `
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Images missing alt text</div>
        <div class="space-y-1 max-h-28 overflow-y-auto">${missingList.slice(0, 10).map(src => `
          <div class="text-[10px] bg-orange-50 text-orange-700 px-2 py-1 rounded truncate">${esc(src)}</div>`).join('')}
          ${missingList.length > 10 ? `<div class="text-[10px] text-slate-400">+${missingList.length - 10} more</div>` : ''}
        </div>` : ''}
    `);
  }

  // ── Speed Optimizations ───────────────────────────────────────────────────
  const comp = techData?.compression;
  const domCount = techData?.dom_element_count;
  const pageKb = techData?.page_weight_kb;
  if (comp !== undefined || domCount !== undefined) {
    const compOk = comp?.enabled;
    const domOk = domCount <= 1500;
    const sizeOk = pageKb <= 150;
    const speedPassed = [compOk, domOk, sizeOk].filter(Boolean).length;
    addCard('card-speed', 'seo', `
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">⚡ Speed Optimizations</div>
        <span class="text-xs text-slate-400">${speedPassed}/3 passed</span>
      </div>
      <div class="space-y-2">
        <div class="flex items-center justify-between p-2.5 rounded-lg ${compOk ? 'bg-green-50' : 'bg-orange-50'}">
          <div>
            <div class="text-xs font-medium ${compOk ? 'text-green-800' : 'text-orange-800'}">HTML Compression</div>
            <div class="text-[10px] ${compOk ? 'text-green-600' : 'text-orange-500'} mt-0.5">
              ${comp?.enabled ? `${comp.encoding} — ${comp.savings_pct != null ? comp.savings_pct + '% savings' : 'enabled'}` : 'Not enabled — add GZIP or Brotli'}
            </div>
          </div>
          <span class="text-base">${compOk ? '✓' : '✗'}</span>
        </div>
        <div class="flex items-center justify-between p-2.5 rounded-lg ${domOk ? 'bg-green-50' : 'bg-amber-50'}">
          <div>
            <div class="text-xs font-medium ${domOk ? 'text-green-800' : 'text-amber-800'}">DOM Size</div>
            <div class="text-[10px] ${domOk ? 'text-green-600' : 'text-amber-600'} mt-0.5">${(domCount ?? 0).toLocaleString()} elements (target ≤ 1,500)</div>
          </div>
          <span class="text-base">${domOk ? '✓' : '⚠'}</span>
        </div>
        <div class="flex items-center justify-between p-2.5 rounded-lg ${sizeOk ? 'bg-green-50' : 'bg-amber-50'}">
          <div>
            <div class="text-xs font-medium ${sizeOk ? 'text-green-800' : 'text-amber-800'}">Page Weight</div>
            <div class="text-[10px] ${sizeOk ? 'text-green-600' : 'text-amber-600'} mt-0.5">${pageKb ?? 0} KB ${sizeOk ? '— within budget' : '— consider lazy-loading & code-splitting'}</div>
          </div>
          <span class="text-base">${sizeOk ? '✓' : '⚠'}</span>
        </div>
      </div>
      ${techData?.render_blocking_scripts > 0 ? `<div class="mt-2 text-[10px] text-amber-600 bg-amber-50 px-2.5 py-1.5 rounded-lg">⚠ ${techData.render_blocking_scripts} render-blocking script${techData.render_blocking_scripts > 1 ? 's' : ''} — add async/defer attributes</div>` : ''}
    `);
  }

  // ── Mobile Usability ──────────────────────────────────────────────────────
  const hasViewport = techData?.checks?.find(c => c.name === 'Mobile viewport meta')?.passed;
  const hasMQ = techData?.has_media_queries;
  if (hasViewport !== undefined || hasMQ !== undefined) {
    const viewportContent = techData?.page_meta?.title ? 'width=device-width, initial-scale=1' : null;
    addCard('card-mobile', 'seo', `
      <div class="font-semibold text-sm mb-3">📱 Mobile Usability</div>
      <div class="space-y-2">
        <div class="flex items-center justify-between p-2.5 rounded-lg ${hasViewport ? 'bg-green-50' : 'bg-orange-50'}">
          <div>
            <div class="text-xs font-medium ${hasViewport ? 'text-green-800' : 'text-orange-800'}">Viewport Meta Tag</div>
            <div class="text-[10px] ${hasViewport ? 'text-green-600' : 'text-orange-500'} mt-0.5 font-mono">${hasViewport ? 'width=device-width, initial-scale=1' : 'Not set — mobile browsers will zoom out'}</div>
          </div>
          <span class="text-base">${hasViewport ? '✓' : '✗'}</span>
        </div>
        <div class="flex items-center justify-between p-2.5 rounded-lg ${hasMQ ? 'bg-green-50' : 'bg-amber-50'}">
          <div>
            <div class="text-xs font-medium ${hasMQ ? 'text-green-800' : 'text-amber-800'}">Responsive CSS (Media Queries)</div>
            <div class="text-[10px] ${hasMQ ? 'text-green-600' : 'text-amber-600'} mt-0.5">${hasMQ ? 'CSS media queries detected — layout adapts to screen size' : 'No media queries found — layout may not adapt to mobile'}</div>
          </div>
          <span class="text-base">${hasMQ ? '✓' : '⚠'}</span>
        </div>
        ${(techData?.deprecated_tags ?? []).length > 0 ? `
        <div class="p-2.5 rounded-lg bg-amber-50">
          <div class="text-xs font-medium text-amber-800 mb-0.5">Deprecated HTML Tags</div>
          <div class="text-[10px] text-amber-600">Found: &lt;${(techData.deprecated_tags).join('&gt;, &lt;')}&gt; — these affect rendering consistency</div>
        </div>` : ''}
        ${techData?.unsafe_cross_origin_links > 0 ? `
        <div class="p-2.5 rounded-lg bg-amber-50">
          <div class="text-xs font-medium text-amber-800 mb-0.5">Unsafe Cross-Origin Links</div>
          <div class="text-[10px] text-amber-600">${techData.unsafe_cross_origin_links} link${techData.unsafe_cross_origin_links > 1 ? 's' : ''} with target="_blank" missing rel="noopener noreferrer"</div>
        </div>` : ''}
      </div>
    `);
  }

  // ── Email & Ads.txt ───────────────────────────────────────────────────────
  const hasAdsTxt = techData?.ads_txt;
  const spfRecord = techData?.spf_record;
  const plaintextEmails = techData?.plaintext_emails ?? 0;
  if (hasAdsTxt !== undefined || spfRecord !== undefined || plaintextEmails > 0) {
    addCard('card-email-ads', 'seo', `
      <div class="font-semibold text-sm mb-3">📧 Email & Ads Security</div>
      <div class="space-y-2">
        <div class="flex items-center justify-between p-2.5 rounded-lg ${spfRecord ? 'bg-green-50' : 'bg-orange-50'}">
          <div>
            <div class="text-xs font-medium ${spfRecord ? 'text-green-800' : 'text-orange-800'}">SPF Email Record</div>
            <div class="text-[10px] ${spfRecord ? 'text-green-600 font-mono' : 'text-orange-500'} mt-0.5 truncate max-w-[220px]">${spfRecord ? esc(spfRecord) : 'Missing — emails can be spoofed from your domain'}</div>
          </div>
          <span class="text-base">${spfRecord ? '✓' : '✗'}</span>
        </div>
        <div class="flex items-center justify-between p-2.5 rounded-lg ${hasAdsTxt ? 'bg-green-50' : 'bg-slate-50'}">
          <div>
            <div class="text-xs font-medium ${hasAdsTxt ? 'text-green-800' : 'text-slate-600'}">Ads.txt File</div>
            <div class="text-[10px] ${hasAdsTxt ? 'text-green-600' : 'text-slate-400'} mt-0.5">${hasAdsTxt ? 'Present — authorized digital sellers declared' : 'Not found — only relevant for ad-supported sites'}</div>
          </div>
          <span class="text-base">${hasAdsTxt ? '✓' : '—'}</span>
        </div>
        ${plaintextEmails > 0 ? `
        <div class="p-2.5 rounded-lg bg-amber-50">
          <div class="text-xs font-medium text-amber-800 mb-0.5">Plaintext Email Links</div>
          <div class="text-[10px] text-amber-600">${plaintextEmails} mailto: link${plaintextEmails > 1 ? 's' : ''} — email addresses visible to scrapers and spam bots</div>
        </div>` : ''}
      </div>
    `);
  }

  // ── International SEO ─────────────────────────────────────────────────────
  if (techData) {
    const langVal = techData.page_meta?.lang ?? null;
    const hreflangPassed = techData.checks?.find(c => c.name === 'hreflang for multilingual')?.passed ?? false;
    const siHosting = mods.site_intel?.data?.hosting;

    // ccTLD → country map (most common ones globally)
    const ccTldMap = {
      uk: 'United Kingdom', de: 'Germany', fr: 'France', es: 'Spain', it: 'Italy',
      nl: 'Netherlands', au: 'Australia', ca: 'Canada', jp: 'Japan', kr: 'South Korea',
      cn: 'China', ru: 'Russia', br: 'Brazil', mx: 'Mexico', ar: 'Argentina',
      in: 'India', sg: 'Singapore', ae: 'United Arab Emirates', za: 'South Africa',
      nz: 'New Zealand', ie: 'Ireland', se: 'Sweden', no: 'Norway', dk: 'Denmark',
      fi: 'Finland', pl: 'Poland', pt: 'Portugal', be: 'Belgium', ch: 'Switzerland',
      at: 'Austria', gr: 'Greece', tr: 'Turkey', id: 'Indonesia', th: 'Thailand',
      my: 'Malaysia', ph: 'Philippines', vn: 'Vietnam', ng: 'Nigeria', ke: 'Kenya',
      eg: 'Egypt', sa: 'Saudi Arabia', pk: 'Pakistan', bd: 'Bangladesh',
    };
    // Also handle co.uk, com.au, org.uk, etc.
    const parts = data.domain.split('.');
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    const isCcTld = tld in ccTldMap;
    const isPseudoCcTld = (sld === 'co' || sld === 'com' || sld === 'org' || sld === 'net') && tld in ccTldMap;
    const ccCountry = isCcTld ? ccTldMap[tld] : (isPseudoCcTld ? ccTldMap[tld] : null);

    // BCP-47 lang → readable name (common subset)
    const langNames = {
      'en': 'English', 'en-gb': 'English (UK)', 'en-us': 'English (US)', 'en-au': 'English (AU)',
      'de': 'German', 'de-de': 'German (Germany)', 'de-at': 'German (Austria)', 'de-ch': 'German (Switzerland)',
      'fr': 'French', 'fr-fr': 'French (France)', 'fr-be': 'French (Belgium)', 'fr-ch': 'French (Switzerland)',
      'es': 'Spanish', 'es-es': 'Spanish (Spain)', 'es-mx': 'Spanish (Mexico)', 'es-ar': 'Spanish (Argentina)',
      'it': 'Italian', 'nl': 'Dutch', 'pt': 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
      'pt-pt': 'Portuguese (Portugal)', 'ru': 'Russian', 'zh': 'Chinese', 'zh-cn': 'Chinese (Simplified)',
      'zh-tw': 'Chinese (Traditional)', 'ja': 'Japanese', 'ko': 'Korean', 'ar': 'Arabic',
      'hi': 'Hindi', 'tr': 'Turkish', 'pl': 'Polish', 'sv': 'Swedish', 'da': 'Danish',
      'fi': 'Finnish', 'no': 'Norwegian', 'el': 'Greek', 'cs': 'Czech', 'ro': 'Romanian',
      'hu': 'Hungarian', 'bg': 'Bulgarian', 'hr': 'Croatian', 'sk': 'Slovak', 'sl': 'Slovenian',
      'uk': 'Ukrainian', 'id': 'Indonesian', 'ms': 'Malay', 'th': 'Thai', 'vi': 'Vietnamese',
    };
    const langName = langVal ? (langNames[langVal.toLowerCase()] ?? langVal) : null;

    const row = (icon, label, value, cls = '') =>
      `<div class="flex items-center gap-2 py-1.5 border-b border-slate-50 last:border-0">
        <span class="text-base w-5 text-center">${icon}</span>
        <span class="text-xs text-slate-500 w-36 shrink-0">${label}</span>
        <span class="text-xs font-medium ${cls || 'text-slate-800'}">${value}</span>
      </div>`;

    const geoLoc = geoData?.location;

    addCard('card-international-seo', 'seo', `
      <div class="font-semibold text-sm mb-3">🌍 International SEO</div>
      <div class="divide-y divide-slate-50">
        ${row(langName ? '✓' : '⚠', 'HTML lang attribute',
          langVal ? `<code class="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-[11px]">${esc(langVal)}</code> — ${esc(langName ?? langVal)}` : '<span class="text-amber-600">Not set — add lang to &lt;html&gt;</span>')}
        ${row(hreflangPassed ? '✓' : '—', 'hreflang tags',
          hreflangPassed
            ? '<span class="text-green-700">Present — multilingual/regional targeting active</span>'
            : '<span class="text-slate-400">Not detected — add only if serving multiple languages/regions</span>')}
        ${ccCountry ? row('🏳', 'Country-code TLD', `<span class="text-blue-700">.${esc(tld)} → ${esc(ccCountry)}</span>`) : ''}
        ${siHosting?.country ? row('🖥', 'Server location',
          `${esc([siHosting.city, siHosting.country].filter(Boolean).join(', '))}`) : ''}
        ${geoLoc && geoLoc !== 'your area' ? row('📍', 'Detected audience',
          `<span class="text-purple-700">${esc(geoLoc)}</span>`) : ''}
      </div>
      ${!hreflangPassed && (isCcTld || isPseudoCcTld) ? `
        <div class="mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          ⚠ Country-code TLD detected but no hreflang found. If you serve multiple regions or languages,
          add <code class="bg-amber-100 px-1 rounded font-mono">rel="alternate" hreflang="..."</code> tags to signal each region to Google.
        </div>` : ''}
      ${hreflangPassed ? `
        <div class="mt-3 p-2.5 bg-green-50 border border-green-200 rounded-lg text-xs text-green-800">
          ✓ hreflang detected — ensure each page has a reciprocal tag and includes <code class="bg-green-100 px-1 rounded font-mono">x-default</code> for language-neutral URLs.
        </div>` : ''}
    `);
  }

  // ── Keyword Research ──────────────────────────────────────────────────────
  // Skip if AI was unavailable — template-generated keywords are too generic to be useful.
  if (kwData?.keywords?.length && kwData.is_reliable !== false) {
    const kws = kwData.keywords.slice(0, 25);
    const intentMeta = {
      transactional: { label: 'Transactional', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
      commercial:    { label: 'Commercial',    cls: 'bg-blue-100 text-blue-700 border-blue-200' },
      informational: { label: 'Informational', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
      local:         { label: 'Local',         cls: 'bg-green-100 text-green-700 border-green-200' },
    };
    const seeds = kwData.seed_queries ?? [];

    addCard('card-keyword-research', 'geo', `
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="font-semibold text-sm">🔑 Keyword Opportunities</div>
          <div class="text-xs text-slate-400 mt-0.5">
            Vertical: <span class="font-medium text-slate-600">${esc(kwData.vertical || 'general')}</span>
            ${kwData.location && kwData.location !== 'your area' ? ` · Location: <span class="font-medium text-slate-600">${esc(kwData.location)}</span>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-slate-400">
          <span class="text-purple-600 font-medium">✦ = AI search potential</span>
        </div>
      </div>
      ${seeds.length ? `
        <div class="mb-3">
          <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Seed queries</div>
          <div class="flex flex-wrap gap-1.5">${seeds.map(s => `<span class="text-[10px] font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded">${esc(s)}</span>`).join('')}</div>
        </div>` : ''}
      <div class="border border-slate-100 rounded-lg overflow-hidden">
        <div class="grid grid-cols-[1fr_auto_auto] text-[10px] font-semibold text-slate-400 uppercase tracking-wide bg-slate-50 px-3 py-2 border-b border-slate-100">
          <span>Keyword</span><span class="text-center w-24">Intent</span><span class="text-center w-10">GEO</span>
        </div>
        <div class="divide-y divide-slate-50">
          ${kws.map(k => {
            const m = intentMeta[k.intent] ?? intentMeta.commercial;
            return `<div class="grid grid-cols-[1fr_auto_auto] items-center px-3 py-2 hover:bg-slate-50 transition-colors">
              <span class="text-xs text-slate-800 truncate pr-2">${esc(k.keyword)}</span>
              <span class="text-[10px] font-medium border rounded-full px-2 py-0.5 w-24 text-center ${m.cls}">${m.label}</span>
              <span class="text-center w-10 text-[13px]">${k.geo_potential ? '<span class="text-purple-600" title="Likely to appear in AI-generated answers">✦</span>' : '<span class="text-slate-200">—</span>'}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="mt-2 text-[10px] text-slate-400">
        ✦ = keyword likely to trigger AI-generated answers in ChatGPT, Perplexity &amp; Gemini
      </div>
    `);
  }

  // ── Keywords Cloud ────────────────────────────────────────────────────────
  const topKw = techData?.top_keywords ?? [];
  if (topKw.length >= 5) {
    const maxCount = topKw[0]?.count || 1;
    // Sort alphabetically so large and small words are distributed throughout the cloud
    const cloudWords = [...topKw.slice(0, 50)].sort((a, b) => a.word.localeCompare(b.word));
    addCard('card-keywords-cloud', 'seo', `
      <div class="flex items-center justify-between mb-4">
        <div class="font-semibold text-sm">☁️ Page Keywords Cloud</div>
        <span class="text-xs text-slate-400">${cloudWords.length} words</span>
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1.5 leading-loose justify-center">
        ${cloudWords.map(({ word, count }) => {
          const ratio = count / maxCount;
          const size = ratio >= 0.8 ? '2rem' : ratio >= 0.6 ? '1.5rem' : ratio >= 0.4 ? '1.1rem' : ratio >= 0.2 ? '0.875rem' : '0.75rem';
          const weight = ratio >= 0.6 ? '700' : ratio >= 0.3 ? '600' : '400';
          const color = ratio >= 0.6 ? 'text-slate-800' : ratio >= 0.3 ? 'text-blue-700' : 'text-slate-500';
          return `<span title="${count} occurrences" style="font-size:${size};font-weight:${weight}" class="${color} hover:text-blue-500 cursor-default transition-colors">${esc(word)}</span>`;
        }).join('')}
      </div>
    `);
  }

  // ── Competitor Comparison ─────────────────────────────────────────────────
  addCard('card-competitor', 'geo', `
    <div class="font-semibold text-sm mb-1">⚡ Compare vs Competitor</div>
    <p class="text-xs text-slate-500 mb-3">See exactly how your SEO &amp; AI visibility stacks up against any competitor — side by side.</p>
    <div class="flex gap-2">
      <div class="relative flex-1">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-4.35-4.35"/></svg>
        <input id="competitor-input" type="text" placeholder="competitor.com"
          class="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400">
      </div>
      <button id="competitor-btn" onclick="runCompetitorComparison()"
        class="shrink-0 text-sm bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white px-4 py-2 rounded-lg font-semibold transition-colors">
        Compare →
      </button>
    </div>
    <div id="competitor-results" class="mt-4 hidden"></div>
  `);

  // wire Enter key on competitor input
  setTimeout(() => {
    const ci = document.getElementById('competitor-input');
    if (ci) ci.addEventListener('keydown', e => { if (e.key === 'Enter') runCompetitorComparison(); });
  }, 0);

}

// ── Competitor Comparison ─────────────────────────────────────────────────────
async function runCompetitorComparison() {
  const input   = document.getElementById('competitor-input');
  const results = document.getElementById('competitor-results');
  const btn     = document.getElementById('competitor-btn');
  if (!input || !results || !btn || !currentDomain) return;

  const raw = input.value.trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  if (!raw || !raw.includes('.')) {
    input.classList.add('border-orange-300', 'ring-1', 'ring-orange-300');
    input.focus();
    return;
  }
  input.classList.remove('border-orange-300', 'ring-1', 'ring-orange-300');

  btn.disabled = true;
  btn.textContent = 'Comparing…';
  results.classList.remove('hidden');
  results.innerHTML = `
    <div class="flex items-center gap-2 text-xs text-slate-400 py-2">
      <svg class="spinner w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
      Running comparison audit — typically 10–20s…
    </div>`;

  try {
    const res = await fetch(`${API}/api/compare?domains=${encodeURIComponent(currentDomain)},${encodeURIComponent(raw)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const mine   = data[currentDomain] ?? {};
    const theirs = data[raw]           ?? {};

    const s = (n) => Math.round(n ?? 0);
    const bar = (n, color) =>
      `<div class="w-full bg-slate-100 rounded-full h-1.5 mt-1">
        <div class="${color} h-1.5 rounded-full transition-all" style="width:${n}%"></div>
      </div>`;
    const scoreColor = (n) => n >= 70 ? 'text-green-700' : n >= 50 ? 'text-yellow-600' : 'text-orange-600';
    const barColor   = (n) => n >= 70 ? 'bg-green-500'   : n >= 50 ? 'bg-yellow-400'  : 'bg-orange-400';

    const row = (icon, label, myVal, theirVal) => {
      const delta = myVal - theirVal;
      const winning = delta >= 0;
      const sign = delta > 0 ? '+' : '';
      return `
        <div class="grid grid-cols-[1fr_80px_80px_60px] gap-2 items-center py-2.5 border-b border-slate-100 last:border-0">
          <div class="text-xs font-medium text-slate-600">${icon} ${label}</div>
          <div class="text-center">
            <div class="text-base font-bold ${scoreColor(myVal)}">${myVal}</div>
            ${bar(myVal, barColor(myVal))}
          </div>
          <div class="text-center">
            <div class="text-base font-bold ${scoreColor(theirVal)}">${theirVal}</div>
            ${bar(theirVal, barColor(theirVal))}
          </div>
          <div class="text-center">
            <span class="text-xs font-bold px-2 py-0.5 rounded-full ${winning ? 'text-green-700 bg-green-50' : 'text-orange-600 bg-orange-50'}">
              ${winning ? '▲' : '▼'} ${sign}${delta}
            </span>
          </div>
        </div>`;
    };

    const overall  = s(mine.overall_score);  const theirOverall  = s(theirs.overall_score);
    const seo      = s(mine.seo_score);      const theirSeo      = s(theirs.seo_score);
    const geo      = s(mine.geo_score);      const theirGeo      = s(theirs.geo_score);
    const delta    = overall - theirOverall;

    const insight = delta <= -15
      ? `<div class="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs">
           <div class="font-semibold text-amber-700 mb-1">⚠ ${esc(raw)} is significantly ahead</div>
           <div class="text-amber-600">
             ${geo < theirGeo - 10 ? `The biggest gap is AI Visibility (+${theirGeo - geo} pts) — the recommendations above will close this.` : `Focus on the highest-impact fixes in the recommendations above to close this gap.`}
           </div>
         </div>`
      : delta >= 15
      ? `<div class="mt-3 p-3 bg-green-50 border border-green-200 rounded-xl text-xs">
           <div class="font-semibold text-green-700 mb-1">✓ You're leading ${esc(raw)} by ${delta} points</div>
           <div class="text-green-600">Strong position. Extending your AI Visibility lead will make this gap even harder to close.</div>
         </div>`
      : `<div class="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs">
           <div class="font-semibold text-blue-700 mb-1">📊 Neck and neck with ${esc(raw)}</div>
           <div class="text-blue-600">Scores are close — even a few targeted fixes could give you the decisive edge.</div>
         </div>`;

    const shareText = `I just compared ${currentDomain} vs ${raw} on GeoScore:\n• My overall: ${overall}/100 vs their ${theirOverall}/100\n• My AI Visibility: ${geo}/100 vs their ${theirGeo}/100\n\nFree audit ↗ geoscoreapp.pages.dev`;

    results.innerHTML = `
      <div class="border border-slate-200 rounded-xl overflow-hidden bg-white">
        <div class="grid grid-cols-[1fr_80px_80px_60px] gap-2 px-4 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
          <div>Metric</div>
          <div class="text-center truncate" title="${esc(currentDomain)}">${esc(currentDomain.length > 12 ? currentDomain.slice(0,11)+'…' : currentDomain)}</div>
          <div class="text-center truncate" title="${esc(raw)}">${esc(raw.length > 12 ? raw.slice(0,11)+'…' : raw)}</div>
          <div class="text-center">Δ</div>
        </div>
        <div class="px-4">
          ${row('🏆', 'Overall', overall, theirOverall)}
          ${row('🔍', 'SEO', seo, theirSeo)}
          ${row('🤖', 'AI Visibility', geo, theirGeo)}
        </div>
      </div>
      ${insight}
      <button
        onclick="navigator.clipboard.writeText(${JSON.stringify(shareText)}).then(()=>{this.textContent='✓ Copied!';setTimeout(()=>this.textContent='📋 Copy comparison',2500)})"
        class="mt-3 w-full text-xs bg-slate-900 hover:bg-slate-700 text-white py-2.5 rounded-lg font-semibold transition-colors">
        📋 Copy comparison
      </button>`;

  } catch (err) {
    results.innerHTML = `<div class="text-xs text-orange-500 py-1">Comparison failed — ${esc(err.message || 'please try again')}.</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compare →';
  }
}

function generousScale(raw) {
  if (raw <= 0) return 0;
  if (raw >= 100) return 100;
  return Math.round(Math.pow(raw / 100, 0.65) * 100);
}

function computeEeat({ techData, schemaData, authData, contentData, offPageData, onPageData }) {
  const hasWikipedia  = !!(authData?.wikipedia);
  const hasWikidata   = !!(authData?.wikidata_id);
  const domainAge     = authData?.domain_age_years ?? 0;
  const isEstablished = (hasWikipedia || hasWikidata) && domainAge >= 5;

  // Experience: content depth, FAQs, video, rich media + real-world authority proxies
  let exp = 0;
  if (contentData?.word_count >= 500) exp += 25;
  else if (contentData?.word_count >= 200) exp += 10;
  if (onPageData?.content?.has_faq) exp += 20;
  if (onPageData?.content?.has_video) exp += 20;
  if (onPageData?.content?.has_table) exp += 10;
  if (onPageData?.images?.total > 3) exp += 10;
  if ((onPageData?.content?.reading_time_min ?? 0) >= 3) exp += 15;
  // Wikipedia/Wikidata presence signals documented real-world experience
  if (hasWikipedia) exp += 20;
  if (hasWikidata)  exp += 10;
  if (domainAge >= 10) exp += 15;
  else if (domainAge >= 5) exp += 8;
  const experience = generousScale(Math.min(100, exp));

  // Expertise: schema quality, content score, heading structure + authority signals
  let expt = 0;
  if (schemaData?.score >= 60) expt += 30;
  else if (schemaData?.score >= 30) expt += 15;
  if (contentData?.score >= 70) expt += 30;
  else if (contentData?.score >= 40) expt += 15;
  if (schemaData?.schemas_found?.some(s => ['Article', 'HowTo', 'FAQPage', 'Course'].includes(s))) expt += 20;
  if (onPageData?.headings?.h2 >= 3) expt += 10;
  if (techData?.checks?.find(c => c.name?.includes('hreflang'))?.passed) expt += 10;
  // Wikipedia/Wikidata are strong expertise signals (entity knowledge graph presence)
  if (hasWikipedia) expt += 20;
  if (hasWikidata)  expt += 15;
  if (isEstablished) expt += 5;
  const expertise = generousScale(Math.min(100, expt));

  // Authoritativeness
  let auth = 0;
  if (authData?.wikipedia) auth += 30;
  if (authData?.wikidata_id) auth += 25;
  if ((authData?.domain_age_years ?? 0) >= 10) auth += 25;
  else if ((authData?.domain_age_years ?? 0) >= 5) auth += 20;
  else if ((authData?.domain_age_years ?? 0) >= 2) auth += 10;
  if ((authData?.backlink_sample_count ?? 0) >= 50) auth += 15;
  else if ((authData?.backlink_sample_count ?? 0) >= 10) auth += 7;
  if ((offPageData?.social_profiles?.length ?? 0) >= 3) auth += 10;
  if (offPageData?.brand_presence?.has_knowledge_panel) auth += 10;
  const authority = generousScale(Math.min(100, auth));

  // Trustworthiness
  let trust = 0;
  if (techData?.checks?.find(c => c.name === 'HTTPS enabled')?.passed) trust += 20;
  if (techData?.security_headers?.score >= 50) trust += 15;
  if (techData?.security_headers?.hsts) trust += 10;
  if (offPageData?.email_security?.has_dmarc &&
      offPageData?.email_security?.dmarc_policy !== 'none') trust += 10;
  if (offPageData?.email_security?.has_spf) trust += 10;
  if (techData?.checks?.find(c => c.name?.includes('Canonical'))?.passed) trust += 10;
  if (techData?.checks?.find(c => c.name?.includes('noindex'))?.passed) trust += 5;
  if ((contentData?.has_phone ?? false)) trust += 10;
  if (techData?.llms_txt_present) trust += 10;
  const trustworthiness = generousScale(Math.min(100, trust));

  const total = Math.round((experience + expertise + authority + trustworthiness) / 4);
  return { experience, expertise, authority, trustworthiness, total };
}

function renderEeatBar(label, letter, score, tooltip) {
  const color = score >= 70 ? 'bg-green-500' : score >= 40 ? 'bg-yellow-400' : 'bg-blue-400';
  const textColor = score >= 70 ? 'text-green-700' : score >= 40 ? 'text-yellow-700' : 'text-blue-600';
  return `<div class="flex items-center gap-2" title="${esc(tooltip)}">
    <span class="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold flex items-center justify-center shrink-0">${letter}</span>
    <span class="text-xs text-slate-600 w-28 shrink-0">${label}</span>
    <div class="flex-1 bg-slate-100 rounded-full h-2">
      <div class="${color} h-2 rounded-full transition-all" style="width:${score}%"></div>
    </div>
    <span class="text-xs font-semibold ${textColor} w-9 text-right">${score}/100</span>
  </div>`;
}

function renderSparklineSvg(values, width = 140, height = 36) {
  if (values.length < 2) return '';
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = values[values.length - 1];
  const lastX = width;
  const lastY = height - ((last - min) / range) * height;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="overflow-visible">
    <polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="#2563eb"/>
  </svg>`;
}

// ── Vertical correction modal ─────────────────────────────────────────────────

let _vmDomain = '';
let _vmCurrentVertical = '';
let _vmPageFingerprint = '';

function openVerticalCorrection(domain, currentVertical) {
  _vmDomain = domain;
  _vmCurrentVertical = currentVertical;

  // Build a page fingerprint from the current DOM (best-effort)
  try {
    const titleEl = document.querySelector('title');
    const descEl = document.querySelector('meta[name="description"]');
    const title = titleEl ? titleEl.textContent.trim() : '';
    const desc = descEl ? (descEl.getAttribute('content') || '') : '';
    _vmPageFingerprint = `${domain} ${title} ${desc}`.trim().slice(0, 500);
  } catch {
    _vmPageFingerprint = domain;
  }

  const modal = document.getElementById('vertical-modal');
  const currentEl = document.getElementById('vm-current');
  const select = document.getElementById('vm-vertical');
  const msg = document.getElementById('vm-msg');
  if (!modal || !currentEl || !select) return;

  currentEl.textContent = currentVertical || 'unknown';
  select.value = '';
  if (msg) { msg.textContent = ''; msg.classList.add('hidden'); }
  modal.classList.remove('hidden');
}

function closeVerticalModal() {
  const modal = document.getElementById('vertical-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitVerticalCorrection() {
  const select = document.getElementById('vm-vertical');
  const msg = document.getElementById('vm-msg');
  const btn = document.getElementById('vm-submit');
  const correctVertical = select ? select.value : '';

  if (!correctVertical) {
    if (msg) { msg.textContent = 'Please select a business type.'; msg.className = 'text-xs mb-3 text-orange-600'; msg.classList.remove('hidden'); }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    const res = await fetch(`${API}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: _vmDomain,
        module: 'geo_predicted',
        field: 'vertical',
        reported_value: _vmPageFingerprint,  // page fingerprint for Vectorize embedding
        correct_value: correctVertical,
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (res.ok) {
      closeVerticalModal();
      // Show re-audit prompt to user
      const modulesEl = document.getElementById('modules');
      const notice = document.createElement('div');
      notice.className = 'bg-green-50 border border-green-200 rounded-xl p-4 fade-in text-sm text-green-800 flex items-center justify-between gap-3';
      notice.style.order = '5';
      notice.innerHTML = `
        <span>Vertical corrected to <strong>${esc(correctVertical)}</strong>. Re-audit to apply it.</span>
        <button onclick="this.closest('div').remove(); startAudit('${esc(_vmDomain)}');"
          class="shrink-0 bg-green-600 hover:bg-green-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
          Re-audit now
        </button>`;
      if (modulesEl) modulesEl.prepend(notice);
    } else {
      if (msg) { msg.textContent = json.error || 'Failed to save. Try again.'; msg.className = 'text-xs mb-3 text-orange-600'; msg.classList.remove('hidden'); }
    }
  } catch {
    if (msg) { msg.textContent = 'Network error. Try again.'; msg.className = 'text-xs mb-3 text-orange-600'; msg.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save & Re-audit'; }
  }
}

// Close modal on backdrop click
document.getElementById('vertical-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('vertical-modal')) closeVerticalModal();
});

// ── Generic module feedback (thumbs-down) ────────────────────────────────────

async function submitModuleFeedback(domain, module, field, reportedValue) {
  try {
    await fetch(`${API}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, module, field, reported_value: reportedValue }),
    });
  } catch { /* best-effort */ }
}
