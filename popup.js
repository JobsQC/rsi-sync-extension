// ── i18n ──────────────────────────────────────────────────────────────────────
const TRANSLATIONS = {
  en: {
    refresh: 'Refresh',
    syncFleet: 'Sync → Fleet',
    howToUseTitle: 'How to use',
    howToUseStep1: '<strong>Sign in</strong> at <span class="accent">robertsspaceindustries.com</span> in this browser.',
    howToUseStep2: 'Click <strong>Refresh</strong> — the extension collects your RSI ships (~20 s).',
    howToUseStep3: 'Go to the Outreach <strong>Fleet</strong> page and click <strong>Sync RSI</strong>, <em>or</em> click <strong>Sync → Fleet</strong> here.',
    howToUseNote: 'If Sync RSI does not respond, reload the Fleet page (F5) after reloading the extension.',
    noData: 'No data yet. Click Refresh to collect your RSI ships.',
    lastSync: 'Last sync: {date}',
    collecting: 'Collecting from RSI…',
    notLoggedIn: 'Not signed in to RSI — sign in at robertsspaceindustries.com then try again.',
    alreadyRunning: 'Collection already running, please wait…',
    loading: 'Loading…',
  },
  fr: {
    refresh: 'Rafraîchir',
    syncFleet: 'Sync → Fleet',
    howToUseTitle: 'Comment utiliser',
    howToUseStep1: '<strong>Connectez-vous</strong> sur <span class="accent">robertsspaceindustries.com</span> dans ce navigateur.',
    howToUseStep2: 'Cliquez <strong>Rafraîchir</strong> — l\'extension collecte vos vaisseaux RSI (~20 s).',
    howToUseStep3: 'Allez sur la page <strong>Fleet</strong> d\'Outreach et cliquez <strong>Sync RSI</strong>, <em>ou</em> cliquez <strong>Sync → Fleet</strong> ici.',
    howToUseNote: 'Si le bouton Sync RSI ne répond pas, rechargez la page Fleet (F5) après avoir rechargé l\'extension.',
    noData: 'Aucune donnée. Cliquez sur Rafraîchir pour collecter vos vaisseaux RSI.',
    lastSync: 'Dernière synchro : {date}',
    collecting: 'Collecte depuis RSI…',
    notLoggedIn: 'Non connecté·e à RSI — connectez-vous sur robertsspaceindustries.com puis réessayez.',
    alreadyRunning: 'Collecte déjà en cours, veuillez patienter…',
    loading: 'Chargement…',
  },
  de: {
    refresh: 'Aktualisieren',
    syncFleet: 'Sync → Flotte',
    howToUseTitle: 'So verwendest du es',
    howToUseStep1: '<strong>Melde dich an</strong> auf <span class="accent">robertsspaceindustries.com</span> in diesem Browser.',
    howToUseStep2: 'Klicke <strong>Aktualisieren</strong> — die Erweiterung sammelt deine RSI-Schiffe (~20 s).',
    howToUseStep3: 'Gehe zur Outreach-<strong>Flotten</strong>seite und klicke <strong>Sync RSI</strong>, <em>oder</em> klicke <strong>Sync → Flotte</strong> hier.',
    howToUseNote: 'Wenn Sync RSI nicht reagiert, lade die Flottenseite neu (F5), nachdem du die Erweiterung neu geladen hast.',
    noData: 'Keine Daten. Klicke auf Aktualisieren, um deine RSI-Schiffe zu sammeln.',
    lastSync: 'Letzte Synchronisierung: {date}',
    collecting: 'Daten von RSI werden gesammelt…',
    notLoggedIn: 'Nicht bei RSI angemeldet — melde dich auf robertsspaceindustries.com an und versuche es erneut.',
    alreadyRunning: 'Sammlung läuft bereits, bitte warten…',
    loading: 'Wird geladen…',
  },
  es: {
    refresh: 'Actualizar',
    syncFleet: 'Sync → Flota',
    howToUseTitle: 'Cómo usarlo',
    howToUseStep1: '<strong>Inicia sesión</strong> en <span class="accent">robertsspaceindustries.com</span> en este navegador.',
    howToUseStep2: 'Haz clic en <strong>Actualizar</strong> — la extensión recopila tus naves RSI (~20 s).',
    howToUseStep3: 'Ve a la página de <strong>Flota</strong> de Outreach y haz clic en <strong>Sync RSI</strong>, <em>o</em> haz clic en <strong>Sync → Flota</strong> aquí.',
    howToUseNote: 'Si Sync RSI no responde, recarga la página de Flota (F5) después de recargar la extensión.',
    noData: 'Sin datos. Haz clic en Actualizar para recopilar tus naves RSI.',
    lastSync: 'Última sincronización: {date}',
    collecting: 'Recopilando desde RSI…',
    notLoggedIn: 'No has iniciado sesión en RSI — inicia sesión en robertsspaceindustries.com e inténtalo de nuevo.',
    alreadyRunning: 'Recopilación ya en curso, por favor espera…',
    loading: 'Cargando…',
  },
}

// Detect browser language, fall back to EN
function detectLang() {
  try {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase()
    return TRANSLATIONS[lang] ? lang : 'en'
  } catch (_) { return 'en' }
}

const lang = detectLang()
const t = TRANSLATIONS[lang]

function _(key, vars) {
  let s = t[key] || TRANSLATIONS.en[key] || key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v)
  return s
}

function el(id) { return document.getElementById(id) }

function fmtDate(ms) {
  try { return new Date(ms).toLocaleString(navigator.language || 'en') } catch (_) { return String(ms) }
}

// ── Apply static i18n to elements ─────────────────────────────────────────────
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = _(node.getAttribute('data-i18n'))
  })
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = _(node.getAttribute('data-i18n-title'))
  })
  // Help panel title
  const helpTitle = document.querySelector('.help-title[data-i18n]')
  if (helpTitle) helpTitle.textContent = _('howToUseTitle')

  // Help steps (HTML content)
  const stepsList = el('helpSteps')
  if (stepsList) {
    stepsList.innerHTML = [
      _('howToUseStep1'),
      _('howToUseStep2'),
      _('howToUseStep3'),
    ].map((s) => `<li>${s}</li>`).join('')
  }

  // Help note
  const helpNote = el('helpNote')
  if (helpNote) helpNote.textContent = _('howToUseNote')
}

// ── Render state (no ship list — status only) ─────────────────────────────────
function renderState(entry, statusOverride) {
  const status = el('status')
  const meta = el('meta')

  if (statusOverride) {
    if (status) status.textContent = statusOverride
    return
  }

  if (!entry || !entry.ships || !entry.ships.length) {
    if (status) status.textContent = _('noData')
    if (meta) meta.textContent = ''
    return
  }

  if (status) status.textContent = ''
  if (meta) meta.textContent = _('lastSync', { date: fmtDate(entry.updatedAt) })
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyI18n()

  const status = el('status')
  if (status) status.textContent = _('loading')

  // Load stored state on open
  chrome.runtime.sendMessage({ action: 'getStored' }, (res) => {
    renderState(res && res.success ? res.data : null)
  })

  // Refresh button
  const btnRefresh = el('btnRefresh')
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      renderState(null, _('collecting'))
      btnRefresh.disabled = true
      btnRefresh.textContent = '…'
      chrome.runtime.sendMessage({ action: 'collectAccount' }, (res) => {
        btnRefresh.disabled = false
        btnRefresh.textContent = _('refresh')
        if (res && res.error === 'not-logged-in') {
          renderState(null, _('notLoggedIn'))
        } else if (res && res.error === 'already-running') {
          renderState(null, _('alreadyRunning'))
        } else if (res && res.success && res.ships && res.ships.length) {
          renderState({ ships: res.ships, updatedAt: Date.now() })
        } else {
          chrome.runtime.sendMessage({ action: 'getStored' }, (r) => {
            renderState(r && r.success ? r.data : null)
          })
        }
      })
    })
  }

  // Sync → Fleet button
  const btnSyncFleet = el('btnSyncFleet')
  if (btnSyncFleet) {
    btnSyncFleet.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOutreachWithStored' }, () => {
        window.close()
      })
    })
  }

  // ? — toggle help panel
  const btnHelp = el('btnHelp')
  const helpPanel = el('helpPanel')
  if (btnHelp && helpPanel) {
    btnHelp.addEventListener('click', () => {
      const open = helpPanel.classList.toggle('hidden')
      btnHelp.style.color = open ? '' : 'var(--accent)'
    })
  }
})
