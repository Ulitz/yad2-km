// ==UserScript==
// @name         Yad2 KM – DEV loader
// @namespace    https://github.com/Ulitz/yad2-km
// @version      1.0.0
// @description  Loads yad2-km-on-search.user.js from a local server on every page load, so the file on disk is the single source of truth.
// @author       Ulitz
// @homepageURL  https://github.com/Ulitz/yad2-km
// @match        https://www.yad2.co.il/vehicles/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Paste this loader into Tampermonkey once and never touch it again.
  // Edit ~/yad2-km-dev/yad2-km-on-search.user.js and just reload the page.
  //
  // Served over HTTP rather than read via file:// because Tampermonkey's
  // GM_xmlhttpRequest refuses file:// URLs even when Chrome's "Allow access to
  // file URLs" is enabled. Start the server with:
  //   cd ~/yad2-km-dev && python3 -m http.server 8137 --bind 127.0.0.1
  const SOURCE = 'http://127.0.0.1:8137/yad2-km-on-search.user.js';

  GM_xmlhttpRequest({
    method: 'GET',
    url: SOURCE,
    // Defeat any caching layer so a reload always gets the file as it is now.
    headers: { 'Cache-Control': 'no-cache' },
    onload(res) {
      if (!res.responseText) {
        console.error('[yad2-km loader] empty response from', SOURCE);
        return;
      }
      try {
        // Indirect eval keeps the payload in global scope rather than this closure.
        (0, eval)(res.responseText);
        console.log('[yad2-km loader] loaded', res.responseText.length, 'bytes');
      } catch (e) {
        console.error('[yad2-km loader] payload threw:', e);
      }
    },
    onerror(e) {
      console.error(
        '[yad2-km loader] could not reach ' + SOURCE + ' — is the local ' +
          'server running? cd ~/yad2-km-dev && python3 -m http.server 8137 --bind 127.0.0.1',
        e
      );
    },
  });
})();
