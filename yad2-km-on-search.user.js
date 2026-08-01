// ==UserScript==
// @name         Yad2 – ק"מ ותצוגה מקדימה בדף החיפוש
// @namespace    https://github.com/Ulitz/yad2-km
// @version      3.0.0
// @description  Adds the odometer reading (km) to each car card on the Yad2 vehicles search page, and opens ads in an in-page preview instead of a new tab.
// @author       Ulitz
// @homepageURL  https://github.com/Ulitz/yad2-km
// @supportURL   https://github.com/Ulitz/yad2-km/issues
// @downloadURL  https://raw.githubusercontent.com/Ulitz/yad2-km/main/yad2-km-on-search.user.js
// @updateURL    https://raw.githubusercontent.com/Ulitz/yad2-km/main/yad2-km-on-search.user.js
// @match        https://www.yad2.co.il/vehicles/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // The preview embeds an ad page in an iframe, and that ad page's URL matches
  // @match too — so without this the script runs inside its own preview and
  // stacks a second overlay in there. @noframes covers the direct install; this
  // guard covers the dev loader, which is the script Tampermonkey actually sees.
  if (window.top !== window.self) return;

  const DEBUG = false;

  // Both features are independent — flip either off without touching the rest.
  const KM_BADGES = true;
  const PREVIEW = true;

  const log = (...a) => DEBUG && console.log('[yad2-km]', ...a);

  // ---------- shared: finding the cards ----------

  // The hrefs are relative ("item/abc123"), so match on the resolved pathname
  // rather than the raw attribute — the attribute never contains the full path.
  //
  // Private listings sit under /vehicles/item/<token>, but dealer and trade-in
  // listings sit under a bare /item/<token>. Both appear in this feed and both
  // expose "km" on their ad page, so accept either shape.
  const ITEM_PATH = /^\/(?:vehicles\/)?item\/([A-Za-z0-9_-]{4,})/;

  function isItemLink(el) {
    return !!el && el.tagName === 'A' && ITEM_PATH.test(el.pathname || '');
  }

  // A bare /item/<token> is also used by non-vehicle verticals, so only treat a
  // link as a car card if it actually has a card row to hang the badge on.
  function itemLinks() {
    return [...document.querySelectorAll('a[href]')].filter(
      (a) => isItemLink(a) && findAnchor(a)
    );
  }

  function tokenOf(link) {
    const m = link.pathname.match(ITEM_PATH);
    return m ? m[1] : null;
  }

  // ================= km badges =================

  // Yad2's search feed is server-rendered and carries no odometer value — the
  // page HTML only has "isZeroKmCar". The real number ("km":22900) exists only
  // on each ad page, so we fetch ads lazily and cache what we learn.

  const CACHE_KEY = 'yad2_km_cache_v2';
  const CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // a listed car's odometer barely moves
  const MAX_CONCURRENT = 3;
  const BADGE_CLASS = 'yad2-km-badge';

  const kmByToken = new Map();
  const requested = new Set();
  const queue = [];
  let inFlight = 0;

  // ---------- cache ----------

  function loadCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      const now = Date.now();
      for (const [token, entry] of Object.entries(raw)) {
        if (entry && typeof entry.km === 'number' && now - entry.t < CACHE_TTL) {
          kmByToken.set(token, entry.km);
        }
      }
    } catch (e) { /* corrupt cache isn't worth crashing over */ }
  }

  let saveTimer = null;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const now = Date.now();
        const out = {};
        for (const [token, km] of kmByToken) out[token] = { km, t: now };
        localStorage.setItem(CACHE_KEY, JSON.stringify(out));
      } catch (e) { /* quota — we'll just refetch next visit */ }
    }, 800);
  }

  // ---------- fetching ----------

  // Carry the ad's own path — dealer ads live at /item/<token>, private ones at
  // /vehicles/item/<token>, and the two are not interchangeable.
  function enqueue(token, path) {
    if (requested.has(token) || kmByToken.has(token)) return;
    requested.add(token);
    queue.push({ token, path });
    pump();
  }

  function pump() {
    // A few at a time: fast enough to feel instant, gentle enough that Yad2's
    // bot protection doesn't challenge the whole tab.
    while (inFlight < MAX_CONCURRENT && queue.length) {
      const { token, path } = queue.shift();
      inFlight++;
      fetch(path, { credentials: 'include' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((html) => {
          // The ad page embeds its RSC payload inline; "km" appears exactly once.
          const m = html.match(/\\?"km\\?"\s*:\s*(\d{1,7})/);
          if (m) {
            kmByToken.set(token, parseInt(m[1], 10));
            saveCache();
            render();
          } else {
            log('no km for', token);
          }
        })
        .catch((e) => log('fetch failed', token, e))
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  // ---------- rendering ----------

  // The feed mixes two card components and they need different anchor points.
  //
  // Wide list card: the "yearAndHand" row has room, so the badge sits inline
  // there and reads as one more spec.
  //
  // Compact carousel card: fixed height with overflow:hidden, and its details
  // line is already flush with the bottom edge — a badge there gets clipped by
  // ~10px and looks missing. Its price box has room, so it goes under the price.
  function findAnchor(link) {
    const wide = link.querySelector('[class*="yearAndHand"]');
    if (wide) return wide;

    const compact = link.querySelector('[class*="vehicle-details-line"], [class*="vehicleDetailsLine"]');
    if (compact) {
      const price = link.querySelector('[class*="priceBox"], [class*="priceB"], [class*="price"]');
      if (price) return price;
      return compact;
    }

    // Last resort: whichever element actually reads "2018 • יד 3".
    const cands = [...link.querySelectorAll('span,div')].filter((el) =>
      /^\d{4}\s*•\s*יד\s*\d+$/.test((el.textContent || '').replace(/\s+/g, ' ').trim())
    );
    return cands.length ? cands[cands.length - 1] : null;
  }

  function render() {
    let shown = 0;
    let pending = 0;

    for (const link of itemLinks()) {
      const token = tokenOf(link);
      if (!token) continue;

      const km = kmByToken.get(token);
      if (km === undefined) {
        enqueue(token, link.pathname);
        pending++;
        continue;
      }

      const row = findAnchor(link);
      if (!row) continue;
      let badge = row.querySelector(':scope > .' + BADGE_CLASS);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        row.appendChild(badge);
      }
      const text = km.toLocaleString('en-US') + ' ק"מ';
      if (badge.textContent !== text) badge.textContent = text;
      shown++;
    }

    log('rendered', shown, 'pending', pending);
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  // ================= in-page preview =================

  // Every card link carries target="_blank", so an ordinary click spawns a tab
  // just to glance at an ad. Intercept the click and show the real ad page in
  // an overlay instead — it's same-origin (X-Frame-Options: SAMEORIGIN), so it
  // frames cleanly and we can quiet its site chrome down to just the ad.
  //
  // Modified clicks (⌘/ctrl/shift/alt, middle-click) are left alone, so "open
  // in a new tab" still works exactly as before when that's what you want.

  const PV = 'yad2-pv';

  // Same-origin access lets us hide the parts of the ad page that only make
  // sense on a full page: the site nav, the SEO footer, the floating
  // accessibility widget, and the cookie banner.
  const FRAME_CSS = `
    header,
    footer,
    #INDmenu-btn,
    #INDshadowRootWrap,
    [class*="cookie-implementation"] { display: none !important; }
  `;

  let overlay = null;
  let lastFocus = null;

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = PV;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="' + PV + '-panel">' +
        '<div class="' + PV + '-bar">' +
          '<span class="' + PV + '-title"></span>' +
          '<a class="' + PV + '-btn ' + PV + '-tab" target="_blank" rel="noopener" title="פתיחה בלשונית חדשה">↗</a>' +
          '<button class="' + PV + '-btn ' + PV + '-close" type="button" aria-label="סגירה" title="סגירה (Esc)">✕</button>' +
        '</div>' +
        '<div class="' + PV + '-body"></div>' +
      '</div>';

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePreview();
    });
    overlay.querySelector('.' + PV + '-close').addEventListener('click', closePreview);
    document.body.appendChild(overlay);
  }

  function titleOf(link) {
    const h = link.querySelector('h2, h3');
    return h ? h.textContent.replace(/\s+/g, ' ').trim() : 'מודעה';
  }

  function openPreview(href, title) {
    if (!overlay) buildOverlay();
    lastFocus = document.activeElement;

    overlay.querySelector('.' + PV + '-title').textContent = title;
    overlay.querySelector('.' + PV + '-tab').href = href;

    const body = overlay.querySelector('.' + PV + '-body');
    body.innerHTML = '<div class="' + PV + '-spinner"></div>';

    // A fresh iframe each time, with src set before insertion: assigning src to
    // an already-live iframe pushes an entry onto the parent's history, which
    // would quietly break the back button after a few previews.
    const frame = document.createElement('iframe');
    frame.className = PV + '-frame';
    frame.src = href;
    frame.addEventListener('load', () => {
      frame.classList.add('ready');
      const spinner = body.querySelector('.' + PV + '-spinner');
      if (spinner) spinner.remove();
      stripChrome(frame);
    });
    body.appendChild(frame);

    document.documentElement.classList.add(PV + '-open');
    overlay.classList.add('open');
    overlay.querySelector('.' + PV + '-close').focus();
  }

  function closePreview() {
    if (!overlay || !overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    document.documentElement.classList.remove(PV + '-open');
    // Drop the iframe rather than hide it, so the ad page stops running.
    overlay.querySelector('.' + PV + '-body').innerHTML = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function isOpen() {
    return !!overlay && overlay.classList.contains('open');
  }

  function stripChrome(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.querySelector('style[data-' + PV + ']')) return;
      const style = doc.createElement('style');
      style.setAttribute('data-' + PV, '');
      style.textContent = FRAME_CSS;
      doc.head.appendChild(style);
    } catch (e) {
      // A cross-origin redirect (login wall, bot check) — show it as it came.
      log('could not style frame', e);
    }
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest && e.target.closest('a[href]');
    if (!isItemLink(link)) return;
    if (link.closest('.' + PV)) return; // a link inside the preview itself

    // Cards embed their own controls — the save-ad heart — so let those act.
    const control = e.target.closest('button, [role="button"], input, label');
    if (control && link.contains(control)) return;

    // Capture phase, so this lands before Yad2's own React handler.
    e.preventDefault();
    e.stopPropagation();
    openPreview(link.href, titleOf(link));
  }

  function onKeydown(e) {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.stopPropagation();
    closePreview();
  }

  function installPreview() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  // ================= styles =================

  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .${BADGE_CLASS} {
        display: inline-block;
        margin-inline-start: 6px;
        padding: 1px 8px;
        border-radius: 999px;
        background: #0d47a1;
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        direction: rtl;
        white-space: nowrap;
        vertical-align: middle;
      }

      html.${PV}-open { overflow: hidden !important; }

      .${PV} {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.55);
        backdrop-filter: blur(2px);
      }
      .${PV}.open { display: flex; }

      .${PV}-panel {
        display: flex;
        flex-direction: column;
        width: min(1180px, 100%);
        height: min(92vh, 100%);
        border-radius: 14px;
        overflow: hidden;
        background: #fff;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
      }

      .${PV}-bar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        direction: rtl;
        padding: 10px 14px;
        background: #0d47a1;
        color: #fff;
        font-size: 15px;
        font-weight: 700;
      }
      .${PV}-title {
        flex: 1 1 auto;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .${PV}-btn {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        font-size: 15px;
        line-height: 1;
        text-decoration: none;
        cursor: pointer;
      }
      .${PV}-btn:hover { background: rgba(255, 255, 255, 0.32); }

      .${PV}-body {
        position: relative;
        flex: 1 1 auto;
        background: #f5f6f8;
      }
      .${PV}-frame {
        width: 100%;
        height: 100%;
        border: 0;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .${PV}-frame.ready { opacity: 1; }

      .${PV}-spinner {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 34px;
        height: 34px;
        border: 3px solid #d7dae0;
        border-top-color: #0d47a1;
        border-radius: 50%;
        animation: ${PV}-spin 0.8s linear infinite;
      }
      @keyframes ${PV}-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ================= boot =================

  function start() {
    addStyles();

    if (KM_BADGES) {
      loadCache();
      render();
      // The feed re-renders on filter changes and pagination, so re-apply on churn.
      new MutationObserver(scheduleRender).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    // One delegated listener on document, so cards added later are covered too.
    if (PREVIEW) installPreview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
