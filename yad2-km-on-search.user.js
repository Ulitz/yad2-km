// ==UserScript==
// @name         Yad2 – ק"מ ותצוגה מקדימה בדף החיפוש
// @namespace    https://github.com/Ulitz/yad2-km
// @version      3.2.0
// @description  Adds the odometer reading (km) and the seller's city to each car card on the Yad2 vehicles search page, opens ads in an in-page preview instead of a new tab, and can hide Chinese-brand cars.
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

  // Keep in step with @version above. Published on <html data-yad2-km="…"> so
  // you can tell which build is actually running — after an auto-update, or
  // when the dev loader is serving something other than what you think.
  const VERSION = '3.2.0';

  // Each feature is independent — flip any off without touching the rest.
  // KM_BADGES and LOC_BADGES share one fetch, so having both costs no more
  // requests than having either.
  const KM_BADGES = true;
  const LOC_BADGES = true;
  const PREVIEW = true;
  const FILTER_CHINESE = true;

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

  // Card titles read "<manufacturer> <model>", but the three card layouts put
  // that string in three different places — and the compact one has no <h2> at
  // all, so anything keyed on <h2> silently skips a third of the feed.
  function titleTextOf(link) {
    const el =
      link.querySelector('[class*="feed-item-info-section"][class*="head"]') ||
      link.querySelector('[class*="heading-line"]') ||
      link.querySelector('h2, h3');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  // Yad2 is inconsistent about Hebrew punctuation: "צ׳רי" uses a geresh (U+05F3)
  // while "דאצ'יה" uses a plain apostrophe, and quotes vary the same way. Compare
  // everything through here or the two spellings never match.
  function norm(s) {
    return (s || '')
      .replace(/[׳‘’ʼ]/g, "'")
      .replace(/[״“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ================= km + location badges =================

  // Yad2's search feed is server-rendered and carries neither the odometer nor
  // the seller's location — the card markup has "isZeroKmCar" and nothing else.
  // Both real values ("km":22900 and the address block) exist only on the ad
  // page, so we fetch each ad lazily, read both out of the one response, and
  // cache what we learn.

  const CACHE_KEY = 'yad2_km_cache_v2';
  const CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // a listed car's odometer barely moves
  const MAX_CONCURRENT = 3;
  const BADGE_CLASS = 'yad2-km-badge';
  const LOC_CLASS = 'yad2-loc-badge';
  const COMBO_CLASS = 'yad2-badge-combo';

  // token -> { km: number|null, city: string|null }. A record whose `city` is
  // `undefined` came from a cache written before locations existed; `null`
  // means we looked and the ad genuinely has none, so it isn't refetched.
  const infoByToken = new Map();
  const requested = new Set();
  const queue = [];
  let inFlight = 0;

  // ---------- cache ----------

  function loadCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      const now = Date.now();
      for (const [token, entry] of Object.entries(raw)) {
        if (!entry || now - entry.t >= CACHE_TTL) continue;
        if (typeof entry.km !== 'number' && entry.km !== null) continue;
        infoByToken.set(token, {
          km: entry.km,
          // Keep undefined distinct from null: pre-3.2.0 entries have no city
          // key at all, and those we do want to fetch again.
          city: typeof entry.city === 'string' || entry.city === null ? entry.city : undefined,
        });
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
        // An undefined city is dropped by JSON.stringify and reads back as
        // undefined, which is what we want: a fetch that hasn't happened yet
        // (or failed) must not be recorded as "this ad has no city".
        for (const [token, info] of infoByToken) {
          out[token] = { km: info.km, city: info.city, t: now };
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(out));
      } catch (e) { /* quota — we'll just refetch next visit */ }
    }, 800);
  }

  // ---------- fetching ----------

  // Carry the ad's own path — dealer ads live at /item/<token>, private ones at
  // /vehicles/item/<token>, and the two are not interchangeable.
  function enqueue(token, path) {
    if (requested.has(token)) return;
    const known = infoByToken.get(token);
    if (known && known.city !== undefined) return;
    requested.add(token);
    queue.push({ token, path });
    pump();
  }

  // The ad payload is sometimes plain JSON and sometimes JSON embedded in a JS
  // string, so every quote may or may not be backslash-escaped — hence the
  // \\? before each one.
  const KM_RE = /\\?"km\\?"\s*:\s*(\d{1,7})/;
  const CITY_RE = /\\?"city\\?"\s*:\s*\{[^}]{0,160}?\\?"text\\?"\s*:\s*\\?"([^"\\]{1,40})/;
  const AREA_RE = /\\?"area\\?"\s*:\s*\{[^}]{0,160}?\\?"text\\?"\s*:\s*\\?"([^"\\]{1,60})/;

  // Dealers selling nationwide list no city at all — only an area, which for
  // them reads "כל הארץ". That's worth showing, so fall back to it.
  function cityOf(html) {
    const city = html.match(CITY_RE);
    if (city) return city[1];
    const area = html.match(AREA_RE);
    // Areas are phrased "אזור חיפה והסביבה"; on a card that's all filler.
    return area ? area[1].replace(/^אזור\s+/, '').replace(/\s+והסביבה$/, '').trim() : null;
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
          // The ad page embeds its RSC payload inline; "km" appears exactly
          // once, and so does the address block it sits near.
          const m = html.match(KM_RE);
          const info = { km: m ? parseInt(m[1], 10) : null, city: cityOf(html) };
          if (info.km === null && info.city === null) {
            log('nothing found for', token);
            return;
          }
          infoByToken.set(token, info);
          saveCache();
          render();
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

  // findAnchor only ever returns a price box for the compact carousel card, so
  // that's what tells the two layouts apart here.
  function isCompactRow(row) {
    return /price/i.test(row.className || '');
  }

  // One <span> per kind per row, reused across renders. The write is guarded
  // because the MutationObserver watches this subtree — an unconditional one
  // would re-trigger render forever.
  function paintBadge(row, cls, text, mod) {
    let badge = row.querySelector(':scope > .' + cls);
    if (!badge) {
      badge = document.createElement('span');
      row.appendChild(badge);
    }
    const full = mod ? cls + ' ' + mod : cls;
    if (badge.className !== full) badge.className = full;
    if (badge.textContent !== text) badge.textContent = text;
  }

  function render() {
    let shown = 0;
    let pending = 0;
    let hidden = 0;

    for (const link of itemLinks()) {
      if (FILTER_CHINESE) {
        if (hideChinese && chineseBrandOf(link)) {
          link.classList.add(HIDDEN_CLASS);
          hidden++;
          continue; // a hidden card shouldn't cost an odometer fetch either
        }
        link.classList.remove(HIDDEN_CLASS);
      }

      if (!KM_BADGES && !LOC_BADGES) continue;

      const token = tokenOf(link);
      if (!token) continue;

      const info = infoByToken.get(token);
      // A pre-3.2.0 cache entry has a km but no city — show the km straight
      // away and let the refetch fill the location in behind it.
      if (!info || info.city === undefined) enqueue(token, link.pathname);
      if (!info) {
        pending++;
        continue;
      }

      const row = findAnchor(link);
      if (!row) continue;

      const km = KM_BADGES && typeof info.km === 'number'
        ? info.km.toLocaleString('en-US') + ' ק"מ'
        : '';
      const city = LOC_BADGES && info.city ? info.city : '';

      // The compact card's price box is only ~170px wide: two separate pills
      // wrap onto a second line there, and the card's fixed height then clips
      // its own title. One combined pill fits on every listing we've seen.
      if (km && city && isCompactRow(row)) {
        paintBadge(row, BADGE_CLASS, km + ' · ' + city, COMBO_CLASS);
      } else {
        if (km) paintBadge(row, BADGE_CLASS, km);
        if (city) paintBadge(row, LOC_CLASS, city);
      }
      shown++;
    }

    if (FILTER_CHINESE) {
      placeToggle();
      paintToggle(hidden);
    }

    log('rendered', shown, 'pending', pending, 'hidden', hidden);
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  // ================= hide Chinese-brand cars =================

  // Filter the feed to electric and it comes back almost entirely Chinese. This
  // hides those cards, matching on the manufacturer name Yad2 itself prints at
  // the start of every card title.
  //
  // Matching is by name rather than by Yad2's manufacturer id: the feed markup
  // that carries ids is only correct for the document as first served, and goes
  // stale after client-side pagination — the printed title never does.
  //
  // Names below are Yad2's own spellings, lifted from its manufacturer filter
  // (all 126 of them); the number is Yad2's manufacturer id, kept only so the
  // list stays checkable against the site later.
  //
  // Four deliberate calls, noted so they don't get "corrected" later:
  //   MG (6) and Maxus (89) are here despite British heritage — today's cars are
  //     wholly SAIC-developed and China-built.
  //   Lynk & Co (321) is here even though its Israeli importer markets it as
  //     "המותג השוודי" and it is engineered in Gothenburg — it was founded in
  //     China, by Geely, and is built there.
  //   Cenntro (97) is the weakest entry: the parent is Nasdaq-listed and US-based,
  //     but the Logistars sold in Israel are China-built.

  const HIDE_KEY = 'yad2_hide_chinese';
  const HIDDEN_CLASS = 'yad2-cn-hidden';

  const CHINESE_BRANDS = [
    'אווטאר',             // 338 Avatr
    'אומודה',             // 369 Omoda
    'אורה',               // 224 Ora
    'אי.וי איזי',         // 323 EVEASY
    'איוויס',             // 288 Aiways
    'איון',               // 379 Aion
    'איי אם',             // 374 IM Motors
    "אם ג'י",             //   6 MG
    'אס דאבל יו אמ',      // 345 SWM
    'אקס אי וי',          // 335 XEV
    'אקסיד',              // 349 Exeed
    'אקספנג',             // 290 XPeng
    'ארקפוקס',            // 117 Arcfox
    'באייק',              // 126 BAIC
    'בי.איי.דאבליו',      // 193 BAW
    'בי.ווי.די',          // 141 BYD
    "ג'אקו",              // 355 Jaecoo
    "ג'י.איי.סי",         //  99 GAC
    'גיאיוואן',           // 346 Jiayuan
    'גרייט וול',          //  11 Great Wall (GWM)
    'ג׳יי.איי.סי',        // 200 JAC
    'ג׳ילי',              // 177 Geely
    'דאבל יו אם מוטורס',  // 329 WM Motor (Weltmeister)
    'דאיון',              // 360 Dayun
    'דונגפנג',            //  88 Dongfeng
    'דיפאל',              // 362 Deepal
    "הונגצ'י",            // 301 Hongqi
    'וויה',               // 322 Voyah
    'ויי',                // 284 WEY
    'זיקר',               // 333 Zeekr
    'יודו',               // 357 Yudo
    'לינק אנד קו',        // 321 Lynk & Co
    'לינקסיס',            // 363 Linxys
    'ליפמוטור',           // 320 Leapmotor
    'מקסוס',              //  89 Maxus
    'נטע',                // 348 Neta
    'ניאו',               // 289 NIO
    "ננג'ינג",            //  78 Nanjing
    'סאנשיין',            //  56 Sunshine
    'סנטרו',              //  97 Cenntro
    'סקייוול',            // 300 Skywell
    'סרס',                // 287 SERES
    'פאריזון',            // 364 Farizon
    'פוטון',              // 352 Foton
    'פורתינג',            // 334 Forthing
    'צ׳רי',               // 147 Chery
    'ריהיי',              // 361 ReHigh
  ];

  // Chinese-OWNED, but Western marques still engineered outside China. Most
  // people don't think of these as Chinese cars, so they stay visible unless you
  // flip this to true.
  const ALSO_HIDE_CHINESE_OWNED = false;

  const CHINESE_OWNED_WESTERN = [
    'וולוו',       //  18 Volvo    — Geely-owned, Swedish
    'פולסטאר',     // 231 Polestar — Geely-owned, Swedish
    'לוטוס',       //  22 Lotus    — Geely-owned, British
    'סמארט',       //  39 Smart    — Geely/Mercedes JV
    'אל.אי.וי.סי', // 299 LEVC     — Geely-owned, British
    'קארמה',       // 203 Karma    — Wanxiang-owned, American
  ];

  let hideChinese = false;
  let matchers = [];

  function loadHidePref() {
    try { hideChinese = localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { hideChinese = false; }
    const names = ALSO_HIDE_CHINESE_OWNED
      ? CHINESE_BRANDS.concat(CHINESE_OWNED_WESTERN)
      : CHINESE_BRANDS;
    // Longest name first, so a short entry can't shadow a longer one that
    // happens to start with it.
    matchers = names.map(norm).sort((a, b) => b.length - a.length);
  }

  // Titles read "<manufacturer> <model>", so the manufacturer is always a
  // whole-word prefix — never a substring test, or "ניאו" would swallow any
  // model containing it.
  function chineseBrandOf(link) {
    const t = norm(titleTextOf(link));
    if (!t) return null;
    for (const b of matchers) {
      if (t === b || t.startsWith(b + ' ')) return b;
    }
    return null;
  }

  // ---------- the toggle ----------

  let toggle = null;

  function buildToggle() {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'yad2-cn-toggle';
    toggle.innerHTML =
      '<span class="yad2-cn-box"></span>' +
      '<span class="yad2-cn-text">הסתר רכבים סיניים</span>' +
      '<span class="yad2-cn-count"></span>';
    toggle.addEventListener('click', (e) => {
      // The toggle lives inside Yad2's own sort bar; don't let the click reach
      // whatever that bar does with clicks.
      e.preventDefault();
      e.stopPropagation();
      hideChinese = !hideChinese;
      try { localStorage.setItem(HIDE_KEY, hideChinese ? '1' : '0'); } catch (e) { /* private mode */ }
      render();
    });
  }

  function placeToggle() {
    if (!toggle) buildToggle();
    if (toggle.isConnected) return;
    // It belongs beside the result count and sort control; if that bar isn't
    // there, fall back to floating so the toggle is never unreachable.
    const bar = document.querySelector('[class*="sortAndTotalBox"], [class*="sort-and-total"]');
    if (bar) {
      toggle.classList.remove('floating');
      bar.appendChild(toggle);
    } else {
      toggle.classList.add('floating');
      document.body.appendChild(toggle);
    }
  }

  function paintToggle(hidden) {
    if (!toggle) return;
    toggle.classList.toggle('on', hideChinese);
    toggle.setAttribute('aria-pressed', hideChinese ? 'true' : 'false');
    const count = toggle.querySelector('.yad2-cn-count');
    // Only write when it actually changes — the MutationObserver watches this
    // subtree, and an unconditional write would re-trigger render forever.
    const text = hideChinese && hidden ? '(' + hidden + ')' : '';
    if (count.textContent !== text) count.textContent = text;
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
    return titleTextOf(link) || 'מודעה';
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

      /* The km-and-city pill on compact cards: a size down, so the longest
         reading we've measured ("155,000 ק"מ · ראשון לציון") still fits. */
      .${BADGE_CLASS}.${COMBO_CLASS} {
        font-size: 11px;
        padding: 1px 7px;
      }

      /* Deliberately quieter than the km pill: the odometer is what you scan
         for, the city is what you check once something looks interesting. */
      .${LOC_CLASS} {
        display: inline-block;
        margin-inline-start: 6px;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid #d7dbe3;
        background: #eef1f6;
        color: #3b414d;
        font-size: 12px;
        font-weight: 600;
        direction: rtl;
        white-space: nowrap;
        vertical-align: middle;
      }

      .${HIDDEN_CLASS} { display: none !important; }

      .yad2-cn-toggle {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin-inline-start: 12px;
        padding: 5px 12px;
        border: 1px solid #c9cdd4;
        border-radius: 999px;
        background: #fff;
        color: #2b2f38;
        font: inherit;
        font-size: 14px;
        line-height: 1.4;
        direction: rtl;
        white-space: nowrap;
        vertical-align: middle;
        cursor: pointer;
      }
      .yad2-cn-toggle:hover { border-color: #0d47a1; }
      .yad2-cn-toggle.on {
        border-color: #0d47a1;
        background: #0d47a1;
        color: #fff;
      }
      /* Physical right, not inset-inline-end: on this RTL page the logical
         side is the left, where Yad2's accessibility button already sits. */
      .yad2-cn-toggle.floating {
        position: fixed;
        bottom: 18px;
        right: 18px;
        z-index: 2147482000;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
      }
      .yad2-cn-box {
        flex: 0 0 auto;
        position: relative;
        width: 14px;
        height: 14px;
        border: 1.5px solid currentColor;
        border-radius: 4px;
      }
      .yad2-cn-toggle.on .yad2-cn-box {
        background: #fff;
        border-color: #fff;
      }
      .yad2-cn-toggle.on .yad2-cn-box::after {
        content: '';
        position: absolute;
        left: 4px;
        top: 1px;
        width: 3px;
        height: 7px;
        border: solid #0d47a1;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }
      .yad2-cn-count { opacity: 0.75; font-size: 13px; }

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
    document.documentElement.dataset.yad2Km = VERSION;
    addStyles();

    if (KM_BADGES || LOC_BADGES) loadCache();
    if (FILTER_CHINESE) loadHidePref();

    if (KM_BADGES || LOC_BADGES || FILTER_CHINESE) {
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
