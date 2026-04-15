// Content script: detects ships on RSI pages and stores them in extension storage
(function () {
  try { console.log('[rsi-extension] contentScript loaded on', location.hostname, location.href) } catch (e) {}
  // Known manufacturer tokens to help identify ship items
  const MANUFACTURERS = ['anvil', 'aegis', 'drake', 'origin', 'misc', 'robertsspaceindustries', 'rsi', 'banu', 'consolidated', 'crusader', 'vanduul', 'esperia', 'kruger', 'polaris', 'tumbril'];

  function normalizeName(raw) {
    if (!raw || typeof raw !== 'string') return ''
    let s = raw.trim()
     const rawLower = (raw || '').toLowerCase()
    // If the raw title explicitly mentions paints/skins/merch, skip it entirely
    if (/\b(paint|livery|skin|decal|wrap|sticker|poster|merch|helmet|hoodie|t-shirt|shirt|jersey|print|bundle|bundle pack|paintkit|paint-kit)\b/i.test(rawLower)) return ''
    // Ignore explicit module items (e.g. "Module Apollo") — not ships
    if (/\bmodule(s)?\b/i.test(rawLower)) return ''
    // remove common prefixes
    s = s.replace(/^\s*(STANDALONE SHIP|STANDALONE SHIPS|PACKAGE|PACK|ITEMS|PACKAGE -|PACKAGE:|PACK -)\s*[-:–—]?\s*/i, '')
    // remove trailing codes like " - IAE 2949" or " - ILW2950"
    s = s.replace(/\s*[-–—]\s*[A-Z0-9\s]{2,}$/i, '')
    // remove parenthesis content
    s = s.replace(/\s*\([^)]*\)\s*/g, '')
    // remove labels like "CONTAINS:" or "Contains:"
    s = s.replace(/^(Contains:|Contains)\s*/i, '')
    // remove noise words (hangar, insurance, lti, flair, skin, paint, etc.)
    s = s.replace(/\b(hangar|hangars|hangar slot|insurance|lti|assurance|flair|flairs|skin|skins|paint|with|includes?|contains?)\b/gi, '')
    return s.trim()
  }

  function isLikelyShipElement(el, name) {
    try {
      let node = el
      for (let i = 0; i < 4 && node; i++) {
        const txt = (node.innerText || '').toLowerCase()
        if (/\bship\b/i.test(txt)) return true
        for (const m of MANUFACTURERS) if (txt.indexOf(m) !== -1) return true
        node = node.parentElement
      }
      const ln = (name || '').toLowerCase()
      for (const m of MANUFACTURERS) if (ln.indexOf(m) !== -1) return true
    } catch (e) {}
    return false
  }

  function isLikelyPaint(container, title) {
    try {
      const txt = (container && container.innerText || '').toLowerCase();
      if (/\b(paint|livery|skin|decal|wrap|sticker|poster|merch|bundle|bundle pack|hoodie|t-shirt|jersey)\b/.test(txt)) {
        const titleLower = (title || '').toLowerCase();
        for (const m of MANUFACTURERS) if (titleLower.indexOf(m) !== -1) return false;
        return true;
      }
    } catch (_) {}
    return false;
  }

  function extractShipsFromDOM() {
    const found = []

    // Candidate selectors likely to contain ship titles
    const titleSelectors = ['[data-ship-name]', '.ship-name', '.item-title', '.product-title', '.listing .title', '.pack .title', '.package .title', '.card-title', '.title', '.name']
    for (const sel of titleSelectors) {
      const els = Array.from(document.querySelectorAll(sel) || [])
      for (const el of els) {
        try {
          const raw = (el.innerText || '').trim()
          const name = normalizeName(raw)
          if (!name) continue
          // prefer elements whose container indicates it's a ship
          const container = el.closest('div,li,article,section') || el.parentElement
                          if (isLikelyPaint(container || el, raw)) continue
                          if (isLikelyShipElement(container || el, name)) found.push(name)
        } catch (_) {}
      }
      if (found.length) break
    }

    // fallback: scan containers that have "Contains" or "Package" markers
    if (!found.length) {
      // Strategy: parse Next.js hydration JSON if present — some pledge data is embedded here.
      try {
        const nextEl = document.querySelector('script#__NEXT_DATA__')
        if (nextEl && nextEl.textContent) {
          try {
            const nextJson = JSON.parse(nextEl.textContent)
            function crawlJson(val, depth) {
              if (!val || depth > 12) return
              if (typeof val === 'string') {
                const txt = String(val)
                const mi = txt.match(/Contains:\s*([^\n\r]+)/i)
                if (mi && mi[1]) {
                  const parts = mi[1].replace(/,?\s*and\s+\d+\s+(?:more\s+)?(?:other\s+)?items?\s*$/i, '').split(/,|\s+and\s+(?!\d)/i).map(i => i.trim()).filter(Boolean)
                  for (const p of parts) {
                    const name = normalizeName(p)
                    if (name && !isLikelyPaint(document.body, p) && isLikelyShipElement(document.body, name)) found.push(name)
                  }
                }
              } else if (Array.isArray(val)) {
                for (const v of val) crawlJson(v, depth + 1)
              } else if (typeof val === 'object') {
                for (const k of Object.keys(val)) crawlJson(val[k], depth + 1)
              }
            }
            crawlJson(nextJson, 0)
          } catch (_) {}
        }
      } catch (_) {}
      const containers = Array.from(document.querySelectorAll('div,section,article,li') || [])
      for (const c of containers) {
        try {
          const text = (c.innerText || '')
          if (!/Contains:|CONTAINS|PACKAGE|STANDALONE|Contains\b/i.test(text)) continue
          // find heading inside
          const heading = c.querySelector('h1,h2,h3,h4,.title,.heading,.item-title,.pack-title,.name,.ship-name')
          let raw = heading ? (heading.innerText || '').trim() : ''
          if (!raw) {
            // take first non-meta line
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
            for (const L of lines) {
              if (/Contains:|Created:|ATTRIBUTED|UPGRADED|CONTAINS/i.test(L)) continue
              raw = L; break
            }
          }
          const name = normalizeName(raw)
                          if (isLikelyPaint(c, raw)) continue
                          if (name && isLikelyShipElement(c, name)) found.push(name)
        } catch (_) {}
      }
    }

    // helper: try to find an image inside a container
    function findImageUrl(container) {
      try {
        if (!container) return null
        const img = container.querySelector && (container.querySelector('img') || container.querySelector('[data-src]'))
        if (img) return img.src || img.getAttribute('data-src') || null
      } catch (_) {}
      return null
    }

    // helper: detect likely "owned" markers in a container
    function detectOwned(container) {
      try {
        if (!container) return false
        const txt = (container.innerText || '').toLowerCase()
        if (/\bowned\b|\bin hangar\b|\byour hangar\b|\bowned by you\b|\bowned: you\b|\bowned:\b|\bowned\s*\(/i.test(txt)) return true
        // negative markers
        if (/\badd to cart\b|\bpurchase\b|\bbuy now\b|\bpreorder\b|\bstore\b/i.test(txt)) return false
      } catch (_) {}
      return false
    }

    // dedupe and map to objects (include image & ownership when available)
    const unique = Array.from(new Set(found.map(f => f.trim()))).filter(Boolean).map(n => {
      // try to find a container that matches this name to extract image/owned
      let imageUrl = null
      let owned = false
      try {
        const els = Array.from(document.querySelectorAll('div,li,article,section') || [])
        for (const el of els) {
          try {
            const text = (el.innerText || '').trim()
            if (!text) continue
            if (text.indexOf(n) !== -1 || text.toLowerCase().indexOf(n.toLowerCase()) !== -1) {
              imageUrl = findImageUrl(el) || imageUrl
              if (!owned) owned = detectOwned(el)
            }
          } catch (_) {}
        }
      } catch (_) {}
      return { vehicleName: n, imageUrl: imageUrl || null, owned: owned }
    })
    try { console.log('[rsi-extension] extractShipsFromDOM -> found:', found, 'unique:', unique) } catch (e) {}
    return unique
  }

  function storeShips(list) {
    try {
      // Send to background to allow merging/dedupe across pages
      try {
        try {
          chrome.runtime.sendMessage({ action: 'storeShips', ships: list, sourceUrl: location.href }, (resp) => {
            try { if (chrome.runtime.lastError) console.warn('[rsi-extension] storeShips runtime.lastError', chrome.runtime.lastError) } catch (e) {}
          })
        } catch (e) {
          // older fallback
          chrome.runtime.sendMessage({ action: 'storeShips', ships: list, sourceUrl: location.href })
        }
      } catch (e) {
        // fallback to direct storage — guard against orphaned context where chrome.storage is undefined
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ rsi_ships_latest: { ships: list, sourceUrl: location.href, updatedAt: Date.now() } })
          }
        } catch (_) {}
      }
    } catch (e) { }
  }

  // If we're on the Outreach site, only respond to explicit RSI_EXTENSION_REQUEST messages.
  // No proactive push on load — avoids stale-data race when user clicks Sync RSI.
  try {
    const isOutreachPage = location && location.hostname && (
      location.hostname.indexOf('outreach-syndicate') !== -1 ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1'
    )
    if (isOutreachPage) {
      window.addEventListener('message', (event) => {
        if (!event || event.source !== window) return
        const d = event.data || {}
        if (d && d.type === 'RSI_EXTENSION_REQUEST') {
          // "respond-once" guard — fleet page removes its listener on the first RSI_EXTENSION_RESPONSE.
          let responded = false
          function postResponse(payload) {
            if (responded) return
            responded = true
            try { window.postMessage({ type: 'RSI_EXTENSION_RESPONSE', payload }, '*') } catch (_) {}
          }

          // Fallback timer: if collectAccount is slow or the SW takes time to wake,
          // respond with stored ships after 3 s so the fleet page isn't left hanging.
          // Only fires if there ARE stored ships; otherwise we wait for collectAccount.
          let fallbackTimer = null
          try {
            fallbackTimer = setTimeout(() => {
              try {
                chrome.storage.local.get('rsi_ships_latest', (d2) => {
                  try {
                    const s = d2 && d2.rsi_ships_latest
                    if (s && s.ships && s.ships.length) postResponse(s)
                  } catch (_) {}
                })
              } catch (_) {}
            }, 3000)
          } catch (_) {}

          // Primary: trigger fresh collection via background service worker.
          try {
            chrome.runtime.sendMessage({ action: 'collectAccount' }, (res) => {
              try { if (fallbackTimer) clearTimeout(fallbackTimer) } catch (_) {}
              try {
                if (res && res.error === 'not-logged-in') {
                  postResponse({ error: 'not-logged-in' }); return
                }
                if (res && res.success && res.ships && res.ships.length) {
                  postResponse({ ships: res.ships }); return
                }
                // collectAccount returned no ships → fall back to stored
                chrome.storage.local.get('rsi_ships_latest', (d2) => {
                  try { postResponse(d2 && d2.rsi_ships_latest || null) } catch (_) {}
                })
              } catch (_) {
                try {
                  chrome.storage.local.get('rsi_ships_latest', (d2) => {
                    try { postResponse(d2 && d2.rsi_ships_latest || null) } catch (_) {}
                  })
                } catch (_) {}
              }
            })
          } catch (_) {
            // Extension context invalidated (extension was reloaded without page reload).
            // We can no longer reach extension APIs — tell the page to show a reload prompt.
            try { if (fallbackTimer) clearTimeout(fallbackTimer) } catch (_) {}
            postResponse({ error: 'extension-disconnected' })
          }
        }
        // allow the page to request clearing stored payload in the extension
        else if (d && d.type === 'RSI_EXTENSION_CLEAR') {
          try {
            chrome.runtime.sendMessage({ action: 'clearStored' }, (resp) => {
              try { window.postMessage({ type: 'RSI_EXTENSION_CLEAR_RESPONSE', payload: resp || null }, '*') } catch (_) {}
            })
          } catch (_) {}
        }
      })
      // don't run extraction logic on Outreach pages
    } else {
      // initial run on RSI pages
      try {
        const ships = extractShipsFromDOM()
        if (ships && ships.length) {
          storeShips(ships)
          try { window.top.postMessage({ type: 'RSI_EXTENSION_RESPONSE', payload: { ships } }, '*') } catch (_) {}
        }
      } catch (_) { }

      // Observe DOM changes and re-run extraction (debounced)
      let timer = null
      const observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          try {
            const ships = extractShipsFromDOM()
            if (ships && ships.length) {
              storeShips(ships)
              try { window.top.postMessage({ type: 'RSI_EXTENSION_RESPONSE', payload: { ships } }, '*') } catch (_) {}
            }
          } catch (_) {}
        }, 600)
      })
      try { observer.observe(document.body || document.documentElement, { childList: true, subtree: true }) } catch (_) {}
    }
  } catch (_) { }

  // expose message API so popup/background can trigger extraction
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    try { console.log('[rsi-extension] contentScript runtime.onMessage', msg && msg.action) } catch (e) {}
    if (!msg) return
    if (msg.action === 'extractNow') {
      try {
        const ships = extractShipsFromDOM()
        if (ships && ships.length) storeShips(ships)
        try { window.top.postMessage({ type: 'RSI_EXTENSION_RESPONSE', payload: { ships } }, '*') } catch (_) {}
        if (respond) respond({ success: true, ships })
      } catch (e) { if (respond) respond({ success: false, error: String(e) }) }
      return true
    }
  })

})();
