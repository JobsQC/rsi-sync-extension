// Outreach RSI Sync - background service worker (message-driven)
const OUTREACH_SITE = 'https://outreach-syndicate.vercel.app';
const MANUFACTURERS = ['anvil','aegis','drake','origin','misc','robertsspaceindustries','rsi','banu','consolidated','crusader','vanduul','esperia','kruger','polaris','tumbril'];

let accountCollectLock = false;

// ─── Orphaned tab cleanup ─────────────────────────────────────────────────────
// Hidden tabs created by collectFromHiddenTab are tracked in chrome.storage.session
// so they can be cleaned up if the service worker is killed mid-flight.
const TRACKED_TABS_KEY = 'rsi_tracked_tabs';
const TAB_CLEANUP_ALARM = 'rsi-tab-cleanup';

function trackTab(tabId, windowId) {
  try {
    chrome.storage.session.get(TRACKED_TABS_KEY, (data) => {
      try {
        const tabs = (data && Array.isArray(data[TRACKED_TABS_KEY])) ? data[TRACKED_TABS_KEY] : [];
        tabs.push({ tabId, windowId: windowId ?? null, createdAt: Date.now() });
        chrome.storage.session.set({ [TRACKED_TABS_KEY]: tabs });
        // Alarm fires after 2 min — enough margin over the ~35 s max processing time
        chrome.alarms.create(TAB_CLEANUP_ALARM, { delayInMinutes: 2 });
      } catch (_) {}
    });
  } catch (_) {}
}

function untrackTab(tabId) {
  try {
    chrome.storage.session.get(TRACKED_TABS_KEY, (data) => {
      try {
        const tabs = (data && Array.isArray(data[TRACKED_TABS_KEY])) ? data[TRACKED_TABS_KEY] : [];
        const remaining = tabs.filter((t) => t.tabId !== tabId);
        chrome.storage.session.set({ [TRACKED_TABS_KEY]: remaining });
        if (!remaining.length) chrome.alarms.clear(TAB_CLEANUP_ALARM, () => {});
      } catch (_) {}
    });
  } catch (_) {}
}

function cleanupOrphanedTabs() {
  try {
    chrome.storage.session.get(TRACKED_TABS_KEY, (data) => {
      try {
        const tabs = (data && Array.isArray(data[TRACKED_TABS_KEY])) ? data[TRACKED_TABS_KEY] : [];
        if (!tabs.length) return;
        for (const { tabId, windowId } of tabs) {
          try {
            if (windowId != null) chrome.windows.remove(windowId, () => {});
            else chrome.tabs.remove(tabId, () => {});
          } catch (_) {}
        }
        chrome.storage.session.set({ [TRACKED_TABS_KEY]: [] });
      } catch (_) {}
    });
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TAB_CLEANUP_ALARM) cleanupOrphanedTabs();
});

function safeEncodePayload(payload) {
  try {
    return btoa(encodeURIComponent(JSON.stringify(payload)));
  } catch (e) {
    return null;
  }
}

// ─── RSI extraction injected into tabs via executeScript ─────────────────────
//
// EXTRACTION LOGIC:
//   Primary source  → "Contains: <items>" section of each pledge card.
//     The pledge title (e.g. "STANDALONE SHIPS – AEGIS REDEEMER – ILW2950")
//     shows the ORIGINAL/BASE ship and is UNRELIABLE after CCU upgrades.
//     "Contains:" always reflects the CURRENT state of the pledge.
//     Non-ship items (insurance, hangars, flairs, paints, …) are filtered out.
//
//   Fallback source → pledge title, used only when no "Contains:" text is found.
//
// Must be entirely self-contained (no external variable references).
// rsiExtract is async so it can poll the DOM until React/Next.js finishes rendering
// pledge cards. RSI loads pledges via API calls after the initial page load — we must
// wait for "Contains:" to appear in the DOM before attempting extraction.
async function rsiExtract() {
  // ── Non-ship item patterns – filtered from "Contains:" lists ──────────────
  const NON_SHIP = [
    'insurance', 'assurance', 'lti', 'lifetime insurance',
    'hangar', 'hangar flair', 'self land', 'aeroview', 'revel & verse',
    'flair', 'paint', 'livery', 'decal', 'skin', 'wrap', 'camouflage',
    'poster', 'hoodie', 't-shirt', 'shirt', 'jersey', 'helmet',
    'warbond', 'sos beacon', 'beacon', 'ticket', 'pass',
    'physical reward', 'physical', 'squadron 42', 'sq42',
    'module', 'ccu', 'upgrade', 'bundle', 'addon', 'add-on',
    'rental', 'repair kit', 'armor', 'suit', 'backpack',
    'plushie', 'artbook', 'art book', 'soundtrack', 'sticker',
    'schedule c',  // RSI insurance tier
    'centurion',   // RSI insurance tier (not a ship)
    'months', 'month', 'years', 'year', 'weeks', 'days',
  ];

  // ── Wait for React to render pledge content (up to 15 s, polling every 500 ms) ──
  // RSI fetches pledges asynchronously after page load; the DOM starts empty.
  const waitStart = Date.now();
  while (Date.now() - waitStart < 15000) {
    const bt = (document.body && document.body.innerText) || '';
    if (/Contains:/i.test(bt) || /standalone ship|game package/i.test(bt)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const body = (document.body && document.body.innerText) || '';
  const bodyLow = body.toLowerCase();

  // Detect login page
  const loggedOut = (
    (bodyLow.includes('sign in') || bodyLow.includes('log in') || bodyLow.includes('se connecter'))
    && !bodyLow.includes('standalone ship')
    && !bodyLow.includes('game package')
    && !bodyLow.includes('my hangar')
    && !bodyLow.includes('pledge')
  );
  if (loggedOut) return { loggedOut: true, ships: [] };

  const found = new Map();

  // Returns true if this item from a "Contains:" list is likely a ship name
  function isShipItem(raw) {
    const n = (raw || '').toLowerCase().trim();
    if (!n || n.length < 2) return false;
    for (const p of NON_SHIP) if (n.includes(p)) return false;
    if (/^\d/.test(n)) return false;   // "3-Month …", "6 Month …"
    if (n.length < 3) return false;
    return true;
  }

  // Parse items from a "Contains:" value string
  // Input: "Ironclad and 2 items"  →  Output: ["Ironclad"]
  // Input: "Aurora MR, Standard Insurance and 1 item"  →  Output: ["Aurora MR"]
  function parseContainsText(txt) {
    // Strip trailing "and X (more|other)? items?" summary
    let s = (txt || '').replace(/,?\s*and\s+\d+\s+(?:more\s+)?(?:other\s+)?items?\s*$/i, '').trim();
    // Split by comma or "and" not followed by a digit
    const parts = s.split(/,|\s+and\s+(?!\d)/i).map(i => i.trim()).filter(Boolean);
    return parts.filter(isShipItem);
  }

  function addShip(name, container) {
    const n = (name || '').trim();
    if (!n || n.length < 2 || n.length > 80) return;
    const key = n.toLowerCase();
    if (found.has(key)) return;
    const img = container && container.querySelector && container.querySelector('img');
    found.set(key, {
      vehicleName: n,
      imageUrl: img ? (img.src || img.getAttribute('data-src') || null) : null,
    });
  }

  // ── Strategy 1: find pledge card containers, read their "Contains:" line ──
  // Broad card selector — tries to match RSI's various list-item patterns
  const CARD_SELS = [
    '[class*="pledge"]',
    '[class*="list-item"]',
    '[class*="item-wrap"]',
    'li',
    'article',
  ].join(', ');

  for (const card of Array.from(document.querySelectorAll(CARD_SELS))) {
    try {
      if (card.children.length > 30) continue; // skip broad containers
      const txt = (card.innerText || '').trim();
      if (txt.length < 5 || txt.length > 3000) continue;
      const match = txt.match(/Contains:\s*([^\n\r]+)/i);
      if (!match) continue;
      const ships = parseContainsText(match[1]);
      for (const s of ships) addShip(s, card);
    } catch (_) {}
  }

  // ── Strategy 2: full body text line scan — runs ALWAYS alongside Strategy 1.
  // innerText gives one line per block element, so "Contains:" is reliably isolated.
  // Running unconditionally catches ships that Strategy 1 missed (different card structure).
  {
    const lines = body.split(/[\n\r]+/);
    for (const line of lines) {
      const match = line.trim().match(/Contains:\s*(.+)/i);
      if (!match) continue;
      const ships = parseContainsText(match[1]);
      for (const s of ships) addShip(s, null);
    }
  }

  // ── Strategy 3: fallback — pledge title when no "Contains:" text found at all ──
  if (!found.size) {
    const PLEDGE_PREFIX = /^\s*(STANDALONE SHIPS?|GAME PACKAGE[S]?|PACKAGE)\s*[-–—:]\s*/i;
    const SKIP_TITLE = /\b(paint|livery|skin|decal|wrap|sticker|merch|helmet|hoodie|t-shirt|shirt|jersey|poster|flair|module)\b/i;
    // Only strip well-known event/promo suffixes, NOT ship variant names (Star Kitten, Yellowjacket…)
    const EVENT_SUFFIX = /\s*[-–—]\s*(?:ILW|BIS|IAE|SQ42?|CCU|WARBOND|WB|LTI)\s*\d*\s*$/i;

    function normTitle(raw) {
      let s = (raw || '').trim();
      if (SKIP_TITLE.test(s)) return '';
      s = s.replace(PLEDGE_PREFIX, '');
      s = s.replace(EVENT_SUFFIX, '');
      s = s.replace(/\s*\([^)]*\)\s*/g, '');
      s = s.replace(/\b(hangar|insurance|lti|assurance|flair|flairs|skin|paint|with|includes?|contains?|warbond)\b/gi, '');
      s = s.replace(/\s*[-–—]\s*$/, '');
      return s.trim();
    }

    const TITLE_SELS = '.title, .pledge-title, [class*="pledge"] .title, [class*="list-item"] .title, h3, h4';
    for (const el of Array.from(document.querySelectorAll(TITLE_SELS))) {
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 200 || !PLEDGE_PREFIX.test(txt) || SKIP_TITLE.test(txt)) continue;
      const name = normTitle(txt);
      if (name && name.length > 1) {
        addShip(name, el.closest('[class*="pledge"],[class*="list-item"],li,article') || el.parentElement);
      }
    }
  }

  return { loggedOut: false, ships: Array.from(found.values()) };
}

// ─── Background-fetch HTML parser ────────────────────────────────────────────
// Same Contains-priority logic as rsiExtract, applied to a DOMParser document.
function extractShipsFromDocument(doc) {
  const NON_SHIP = [
    'insurance', 'assurance', 'lti', 'hangar', 'hangar flair', 'self land',
    'flair', 'paint', 'livery', 'decal', 'skin', 'wrap',
    'poster', 'hoodie', 't-shirt', 'shirt', 'jersey', 'helmet',
    'warbond', 'beacon', 'ticket', 'pass', 'physical', 'squadron 42', 'sq42',
    'module', 'ccu', 'upgrade', 'bundle', 'addon', 'rental',
    'armor', 'suit', 'backpack', 'plushie', 'artbook', 'soundtrack', 'sticker',
    'schedule c', 'centurion',
    'months', 'month', 'years', 'year', 'weeks', 'days',
  ];
  const PLEDGE_PREFIX = /^\s*(STANDALONE SHIPS?|GAME PACKAGE[S]?|PACKAGE)\s*[-–—:]\s*/i;
  const SKIP_TITLE = /\b(paint|livery|skin|decal|wrap|sticker|merch|helmet|hoodie|t-shirt|shirt|jersey|poster|flair|module)\b/i;
  // Only strip well-known event/promo codes — NOT generic all-caps suffixes which may be ship variant names
  const EVENT_SUFFIX = /\s*[-–—]\s*(?:ILW|BIS|IAE|SQ42?|CCU|WARBOND|WB|LTI)\s*\d*\s*$/i;

  function isShipItem(raw) {
    const n = (raw || '').toLowerCase().trim();
    if (!n || n.length < 3) return false;
    for (const p of NON_SHIP) if (n.includes(p)) return false;
    if (/^\d/.test(n)) return false;
    return true;
  }

  function parseContainsText(txt) {
    let s = (txt || '').replace(/,?\s*and\s+\d+\s+(?:more\s+)?(?:other\s+)?items?\s*$/i, '').trim();
    return s.split(/,|\s+and\s+(?!\d)/i).map(i => i.trim()).filter(Boolean).filter(isShipItem);
  }

  function normTitle(raw) {
    let s = (raw || '').trim();
    if (SKIP_TITLE.test(s)) return '';
    s = s.replace(PLEDGE_PREFIX, '');
    s = s.replace(EVENT_SUFFIX, '');
    s = s.replace(/\s*\([^)]*\)\s*/g, '');
    s = s.replace(/\b(hangar|insurance|lti|assurance|flair|flairs|skin|paint|with|includes?|contains?|warbond)\b/gi, '');
    s = s.replace(/\s*[-–—]\s*$/, '');
    return s.trim();
  }

  function findImage(container) {
    try {
      const img = container && (container.querySelector('img') || container.querySelector('[data-src]'));
      if (img) return img.src || img.getAttribute('data-src') || null;
    } catch (_) {}
    return null;
  }

  const found = new Map();

  function addShip(name, container) {
    const n = (name || '').trim();
    if (!n || n.length < 2 || n.length > 80) return;
    const key = n.toLowerCase();
    if (!found.has(key)) found.set(key, { vehicleName: n, imageUrl: findImage(container) });
  }

  // Helper: extract Contains: value from raw text, stopping at known non-pledge markers.
  // textContent from DOMParser concatenates block elements without newlines, so we
  // stop at "Created:", "ATTRIBUTED", "UPGRADED", pledge-type prefixes, or 4-digit years.
  function extractContainsValue(txt) {
    const idx = (txt || '').toLowerCase().indexOf('contains:');
    if (idx === -1) return null;
    const after = txt.slice(idx + 9).trim();
    const stop = after.search(/Created:|ATTRIBUTED|UPGRADED|STANDALONE|GAME PACKAGE|PACKAGE|\b\d{4}\b/i);
    return (stop > 0 ? after.slice(0, stop) : after).slice(0, 300).trim();
  }

  // Strategy 0: parse Next.js __NEXT_DATA__ JSON (completely invisible — no tab needed).
  // RSI uses Next.js; pledge data is often embedded in this script tag for SSR hydration.
  // We recursively scan all string values in the JSON for "Contains:" patterns.
  const nextDataEl = doc.querySelector('script#__NEXT_DATA__');
  if (nextDataEl) {
    try {
      const nextJson = JSON.parse(nextDataEl.textContent || '');
      function crawlJson(val, depth) {
        if (!val || depth > 12 || found.size > 100) return;
        if (typeof val === 'string') {
          const cv = extractContainsValue(val);
          if (cv) for (const s of parseContainsText(cv)) addShip(s, null);
        } else if (Array.isArray(val)) {
          for (const v of val) crawlJson(v, depth + 1);
        } else if (typeof val === 'object') {
          for (const k of Object.keys(val)) crawlJson(val[k], depth + 1);
        }
      }
      crawlJson(nextJson, 0);
    } catch (_) {}
  }

  // Strategy 1: pledge card containers → "Contains:" section
  const CARD_SELS = '[class*="pledge"],[class*="list-item"],[class*="item-wrap"],li,article';
  for (const card of Array.from(doc.querySelectorAll(CARD_SELS) || [])) {
    try {
      if (card.children.length > 30) continue;
      const txt = (card.textContent || '').trim();
      if (txt.length < 5 || txt.length > 5000) continue;
      const cv = extractContainsValue(txt);
      if (!cv) continue;
      const ships = parseContainsText(cv);
      for (const s of ships) addShip(s, card);
    } catch (_) {}
  }

  // Strategy 2: full document text scan — runs ALWAYS alongside Strategy 1.
  // DOMParser textContent concatenates block elements without newlines, so we split
  // on known pledge markers as well as real newlines.
  {
    const fullText = (doc.body && doc.body.textContent) || '';
    const segments = fullText.split(/[\n\r]+|(?=STANDALONE SHIPS?|GAME PACKAGE|Contains:)/i);
    for (const seg of segments) {
      const cv = extractContainsValue(seg);
      if (!cv) continue;
      const ships = parseContainsText(cv);
      for (const s of ships) addShip(s, null);
    }
  }

  // Strategy 3: pledge titles fallback
  if (!found.size) {
    const titleSelectors = [
      '[class*="pledge"] .title', '[class*="list-items"] .title',
      '[class*="list-item"] .title', '[data-ship-name]',
      '.ship-name', '.item-title', '.product-title', '.card-title', '.title', '.name',
    ];
    for (const sel of titleSelectors) {
      for (const el of Array.from(doc.querySelectorAll(sel) || [])) {
        try {
          const raw = (el.textContent || '').trim();
          if (!raw || raw.length > 200 || SKIP_TITLE.test(raw)) continue;
          if (!PLEDGE_PREFIX.test(raw)) continue;
          const name = normTitle(raw);
          if (!name || name.length < 2) continue;
          const container = el.closest('div,li,article,section,tr') || el.parentElement;
          if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { vehicleName: name, imageUrl: findImage(container) });
        } catch (_) {}
      }
      if (found.size) break;
    }
  }

  return Array.from(found.values());
}

// ─── Background fetch (invisible — SSR pages) ─────────────────────────────────
async function fetchPage1ForProductType(productType) {
  const url = `https://robertsspaceindustries.com/en/account/pledges?page=1&product-type=${encodeURIComponent(productType)}`;
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    const text = await res.text();
    const finalUrl = res.url || '';

    if (finalUrl.includes('/signin') || finalUrl.includes('/login') || !res.ok) {
      return { ships: [], loggedOut: true };
    }
    const low = (text || '').toLowerCase();
    if (
      (low.includes('sign in') || low.includes('se connecter')) &&
      !low.includes('standalone ship') && !low.includes('game package') && !low.includes('my hangar')
    ) {
      return { ships: [], loggedOut: true };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    const ships = extractShipsFromDocument(doc);
    return { ships, loggedOut: false };
  } catch (e) {
    return { ships: [], loggedOut: false };
  }
}

// ─── Minimized window fallback (CSR pages) ────────────────────────────────────
function waitForTabComplete(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, timeoutMs);
    function listener(id, info) {
      if (id !== tabId) return;
      if (info && info.status === 'complete' && !done) {
        done = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => {
      if (t && t.status === 'complete' && !done) {
        done = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    });
  });
}

// Creates a background tab (not focused, no new window) to load a CSR page.
// The tab is invisible to the user since it's created inactive in an existing window.
// Falls back to a minimized popup window if no existing window is available.
function collectFromHiddenTab(url) {
  return new Promise((resolve) => {
    try {
      function runInTab(tabId, ownWindowId) {
        const closeAndResolve = (result) => {
          untrackTab(tabId);
          try {
            if (ownWindowId != null) chrome.windows.remove(ownWindowId, () => {});
            else chrome.tabs.remove(tabId, () => {});
          } catch (_) {}
          resolve(result);
        };
        // rsiExtract is async and polls internally — inject it right after HTML load.
        // It will wait up to 15 s on its own for React to render pledge cards.
        waitForTabComplete(tabId, 20000)
          .then(() => new Promise((res) => {
            chrome.scripting.executeScript(
              { target: { tabId }, func: rsiExtract },
              (results) => {
                if (chrome.runtime.lastError || !Array.isArray(results) || !results[0]) {
                  return res({ ships: [], loggedOut: false });
                }
                res(results[0].result || { ships: [], loggedOut: false });
              }
            );
          }))
          .then(closeAndResolve)
          .catch(() => closeAndResolve({ ships: [], loggedOut: false }));
      }

      // Prefer adding an inactive tab to an existing window (no new window popup)
      chrome.windows.getAll({ populate: false }, (windows) => {
        const existingWin = windows && windows.find((w) => w.type === 'normal');
        if (existingWin) {
          chrome.tabs.create({ windowId: existingWin.id, url, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab || !tab.id) {
              return resolve({ ships: [], loggedOut: false });
            }
            trackTab(tab.id, null);
            runInTab(tab.id, null);
          });
        } else {
          // No existing window — fall back to minimized popup
          chrome.windows.create({ url, type: 'popup', focused: false, state: 'minimized' }, (win) => {
            if (!win || !win.tabs || !win.tabs[0] || !win.tabs[0].id) {
              return resolve({ ships: [], loggedOut: false });
            }
            trackTab(win.tabs[0].id, win.id);
            runInTab(win.tabs[0].id, win.id);
          });
        }
      });
    } catch (e) {
      resolve({ ships: [], loggedOut: false });
    }
  });
}

// ─── Main collection ──────────────────────────────────────────────────────────
async function collectAccount() {
  const productTypes = ['standalone_ship', 'game_package'];

  // Phase 1 (background fetch, invisible) and Phase 2 (hidden tab, executeScript) run
  // CONCURRENTLY for ALL product types. Neither phase is conditional on the other.
  // Results are merged so that a ship found by either phase is included.
  //
  // Why always run both?
  //   • Phase 1 is fast (~5s) and invisible but may miss ships that need JS rendering.
  //   • Phase 2 is comprehensive (~18s) and catches everything Phase 1 misses.
  //   • Running them together costs only max(5s, 18s) = ~18s total.
  console.log('[rsi-bg] collectAccount: starting Phase 1 + Phase 2 concurrently');

  const [phase1Results, phase2Results] = await Promise.all([
    Promise.all(
      productTypes.map((pt) =>
        fetchPage1ForProductType(pt).catch(() => ({ ships: [], loggedOut: false }))
      )
    ),
    Promise.all(
      productTypes.map((pt) => {
        const url = `https://robertsspaceindustries.com/en/account/pledges?page=1&product-type=${encodeURIComponent(pt)}`;
        return collectFromHiddenTab(url).catch(() => ({ ships: [], loggedOut: false }));
      })
    ),
  ]);

  const allResults = [...phase1Results, ...phase2Results];
  if (allResults.some((r) => r.loggedOut)) return { ships: [], loggedOut: true };

  const aggregated = [];
  for (const r of allResults) if (r.ships && r.ships.length) aggregated.push(...r.ships);

  console.log('[rsi-bg] Phase1:', phase1Results.map((r) => r.ships && r.ships.length),
    'Phase2:', phase2Results.map((r) => r.ships && r.ships.length));

  // Dedupe — prefer imageUrl from Phase 2 (live DOM) over Phase 1 (static fetch)
  const map = new Map();
  for (const s of aggregated) {
    const key = (s.vehicleName || s.name || '').trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { vehicleName: s.vehicleName || s.name, imageUrl: s.imageUrl || null });
    } else if (!map.get(key).imageUrl && s.imageUrl) {
      map.set(key, { ...map.get(key), imageUrl: s.imageUrl });
    }
  }
  return { ships: Array.from(map.values()), loggedOut: false };
}

// ─── Storage ──────────────────────────────────────────────────────────────────
function storeShips(ships, sourceUrl) {
  try {
    chrome.storage.local.get('rsi_ships_latest', (data) => {
      const existing = (data && data.rsi_ships_latest && Array.isArray(data.rsi_ships_latest.ships))
        ? data.rsi_ships_latest.ships : [];

      function normalizeKey(raw) {
        if (!raw) return '';
        try {
          let s = String(raw).toLowerCase().trim();
          s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          s = s.replace(/\b(hangar|hangars|insurance|lti|flair|flairs|skin|skins|paint|livery|decal|merch|t-shirt|hoodie|pack|package|bundle|module|centurion)\b/gi, ' ');
          s = s.replace(/[^a-z0-9]+/g, ' ').trim();
          return s;
        } catch (_) { return String(raw).toLowerCase().trim(); }
      }

      function isProbablyShip(name) {
        if (!name) return false;
        const n = String(name).toLowerCase();
        const neg = ['helmet','poster','ticket','merch','hoodie','t-shirt','soundtrack','sticker','decal','bundle','paint','livery','skin','shirt','module'];
        for (const x of neg) if (n === x || n.startsWith(x + ' ')) return false;
        for (const m of MANUFACTURERS) if (n.includes(m)) return true;
        if (/\bship\b/.test(n)) return true;
        return n.length > 4;
      }

      const incoming = (Array.isArray(ships) ? ships : []).filter(
        (s) => isProbablyShip((s && (s.vehicleName || s.name)) || '')
      );
      const map = new Map();
      for (const s of existing.concat(incoming)) {
        const name = (s && (s.vehicleName || s.name)) || '';
        const key = normalizeKey(name);
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, s);
        } else {
          const prev = map.get(key);
          map.set(key, { ...prev, ...s, imageUrl: prev.imageUrl || s.imageUrl || null });
        }
      }

      const merged = Array.from(map.values());
      const prevSources = (data.rsi_ships_latest && data.rsi_ships_latest.sources) || [];
      chrome.storage.local.set({
        rsi_ships_latest: {
          ships: merged,
          sources: Array.from(new Set([...prevSources, sourceUrl].filter(Boolean))),
          updatedAt: Date.now(),
        },
      });
    });
  } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function waitForTabCompleteAndInject(tabId) {
  try {
    waitForTabComplete(tabId, 10000).then(() => {
      chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] }, () => {
        try { if (chrome.runtime.lastError) {} } catch (_) {}
      });
    }).catch(() => {
      try { chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] }, () => {}); } catch (_) {}
    });
  } catch (_) {}
}

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.action === 'collectAccount') {
    if (accountCollectLock) {
      console.log('[rsi-bg] collectAccount already running, returning stored');
      return sendResponse({ success: false, error: 'already-running' });
    }
    accountCollectLock = true;
    console.log('[rsi-bg] collectAccount started');
    collectAccount().then(({ ships, loggedOut }) => {
      accountCollectLock = false;
      console.log('[rsi-bg] collectAccount done — ships:', ships && ships.length, 'loggedOut:', loggedOut);
      if (loggedOut) return sendResponse({ success: false, error: 'not-logged-in' });
      if (ships && ships.length) storeShips(ships, 'rsi-account-collect');
      sendResponse({ success: true, ships: ships || [] });
    }).catch((e) => {
      accountCollectLock = false;
      console.error('[rsi-bg] collectAccount error:', e);
      sendResponse({ success: false, error: String(e) });
    });
    return true;
  }

  if (msg.action === 'getStored') {
    chrome.storage.local.get('rsi_ships_latest', (data) =>
      sendResponse({ success: true, data: data.rsi_ships_latest || null })
    );
    return true;
  }

  if (msg.action === 'clearStored') {
    chrome.storage.local.remove('rsi_ships_latest', () => sendResponse({ success: true }));
    return true;
  }

  if (msg.action === 'storeShips') {
    try { storeShips(msg.ships || [], msg.sourceUrl || null); } catch (_) {}
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === 'openOutreachWithStored') {
    chrome.storage.local.get('rsi_ships_latest', (data) => {
      const entry = data && data.rsi_ships_latest;
      if (!entry || !entry.ships || !entry.ships.length) return sendResponse({ success: false, error: 'no-stored' });
      const encoded = safeEncodePayload({ ships: entry.ships, source: 'rsi-extension' });
      if (!encoded) return sendResponse({ success: false, error: 'encode-failed' });
      chrome.tabs.create({ url: `${OUTREACH_SITE}/settings/fleet#rsi=${encoded}&auto=1` }, (tab) => {
        sendResponse({ success: true });
        try { if (tab && tab.id) waitForTabCompleteAndInject(tab.id); } catch (_) {}
      });
    });
    return true;
  }

  if (msg.action === 'openOutreachWithShips') {
    try {
      const ships = Array.isArray(msg.ships) ? msg.ships : [];
      if (!ships.length) return sendResponse({ success: false, error: 'no-ships' });
      const encoded = safeEncodePayload({ ships, source: 'rsi-extension' });
      if (!encoded) return sendResponse({ success: false, error: 'encode-failed' });
      chrome.tabs.create({ url: `${OUTREACH_SITE}/settings/fleet#rsi=${encoded}&auto=1` }, (tab) => {
        sendResponse({ success: true });
        try { if (tab && tab.id) waitForTabCompleteAndInject(tab.id); } catch (_) {}
      });
    } catch (e) {
      return sendResponse({ success: false, error: String(e) });
    }
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => { cleanupOrphanedTabs(); });
chrome.runtime.onStartup.addListener(() => { cleanupOrphanedTabs(); });
