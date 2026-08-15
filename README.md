# yad2-km

A Tampermonkey userscript for [Yad2](https://www.yad2.co.il)'s car search, which adds the two
things the feed doesn't give you: **the odometer reading on every card**, and **a way to open an
ad without spawning a tab**.

Hebrew UI, RTL-aware.

## What it does

**km on every card.** The search feed shows year, hand and price, but never mileage — so
comparing listings means opening each one. The script adds a `66,000 ק"מ` pill inline with the
year/hand row.

**In-page preview.** Every card link on Yad2 carries `target="_blank"`, so a click costs you a
tab. Clicking a card now opens the real ad page in an overlay: photos, price, specs, seller,
everything. `Esc`, the ✕, or a click outside closes it.

**Hide Chinese cars.** Narrow the search to electric and the feed comes back mostly Chinese
marques. A `הסתר רכבים סיניים` toggle appears next to the result count, hides them, shows how many
it hid, and remembers the setting.

Nothing you already rely on changes:

- ⌘/Ctrl/Shift-click and middle-click still open a real tab
- the ↗ button in the preview's title bar opens the ad in a tab when you want one
- the save-ad ♡ on a card still saves, instead of opening the preview
- links outside the feed are untouched

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Click **[yad2-km-on-search.user.js](https://raw.githubusercontent.com/Ulitz/yad2-km/main/yad2-km-on-search.user.js)** — Tampermonkey will offer to install it.
3. Open any `yad2.co.il/vehicles/...` search page.

Badges appear as each ad is fetched, so the first load on a fresh cache fills in over a few
seconds. After that they're instant.

## Configuration

Two flags at the top of the script:

```js
const KM_BADGES      = true;
const PREVIEW        = true;
const FILTER_CHINESE = true;
```

Set any to `false` to drop that feature. `DEBUG = true` turns on `[yad2-km]` console logging.

The hide-Chinese filter has one more switch, further down next to the brand lists:

```js
const ALSO_HIDE_CHINESE_OWNED = false;
```

Chinese-*owned* Western marques — Volvo and Polestar under Geely, Lotus, Smart, LEVC, Karma — are
kept **visible** by default, since most people don't think of them as Chinese cars. Flip this to
`true` to hide them as well, or just move individual names between the two lists.

## How it works

### Why it fetches one page per listing

The search feed is server-rendered — Next.js App Router, RSC payload streamed into
`self.__next_f` — and it carries no odometer value. The only related field in the search HTML is
`isZeroKmCar`. There's no feed API to read instead: loading a search page fires **no**
`gw.yad2.co.il` request for listings at all, and App Router emits no `__NEXT_DATA__`. The real
number exists only on the ad page, where `"km":22900` appears exactly once in the inline payload.

So the script fetches each ad page once and caches the result in `localStorage` for 30 days — a
listed car's odometer barely moves. Three requests run at a time, which is fast enough to feel
immediate and gentle enough that Yad2's bot protection doesn't challenge the tab.

### The feed mixes card layouts

Three components share one feed, and they need different treatment:

| Layout | Where the badge goes | Why |
| --- | --- | --- |
| Wide list card | the `yearAndHand` row | has room; reads as one more spec |
| Compact carousel card | under the price box | its details line sits flush against a fixed-height `overflow: hidden` edge, so a badge there gets clipped by ~10px and looks missing |
| Dealer / trade-in card | the `yearAndHand` row | same as wide, but the ad lives at a **bare `/item/<token>`** rather than `/vehicles/item/<token>` |

That last one matters: matching only `/vehicles/item/` silently skips every dealer and trade-in
listing. Both shapes are accepted, and each ad's own path is carried through the fetch queue,
since the two are not interchangeable.

Card hrefs are also *relative* (`item/abc123`), so the script matches on the resolved
`a.pathname` — an attribute selector like `a[href*="/vehicles/item/"]` matches nothing.

### Deciding what counts as a Chinese car

The brand list covers all 126 manufacturers in Yad2's own manufacturer filter, classified into 47
Chinese marques and 6 Chinese-owned Western ones. Every China verdict was checked against Israeli
importer and registry sources, because Hebrew transliteration is lossy — `אס דאבל יו אמ` is a
letter-by-letter reading of "SWM", `לינקסיס` is Wuling's Linxys, `ריהיי` is Dayun's ReHigh.

Matching is on the **manufacturer name**, not Yad2's manufacturer id, even though the feed markup
does carry `"manufacturer":{"id":141,"text":"בי.ווי.די"}`. That data is only correct for the
document as first served and goes stale after client-side pagination — it kept insisting a page of
MG and BYD listings was Toyota. The printed title never lies.

Two details that would silently break it:

- Names are compared as **whole-word prefixes**, never substrings, or `ניאו` (NIO) would hide any
  model whose name contains those letters.
- Hebrew punctuation is normalised first. Yad2 spells `צ׳רי` with a geresh (U+05F3) but `ג'אקו`
  with an ASCII apostrophe, so a literal comparison misses half the list. Note that `ג'י.איי.סי`
  (GAC) and `ג׳יי.איי.סי` (JAC) differ only by that character plus one yod.

Judgment calls, recorded so they don't get "corrected" later: **MG** and **Maxus** are treated as
Chinese despite British heritage, since today's cars are wholly SAIC-developed. **Lynk & Co** is
too, even though its Israeli importer markets it as *המותג השוודי*. **Cenntro** is the weakest
entry — Nasdaq-listed US parent, China-built vans. And **Dacia Spring** stays visible: it is
China-built, but Dacia is not a Chinese marque.

### The preview

Ad pages send `X-Frame-Options: SAMEORIGIN` and no `frame-ancestors` CSP, so from a Yad2 page
they frame cleanly — and being same-origin, the script can inject CSS into the frame to hide the
site nav, the SEO footer, the cookie banner and the floating accessibility widget. What's left is
the ad.

Clicks are intercepted in the **capture** phase, before Yad2's own React handler. Each preview
gets a fresh iframe with `src` set *before* insertion — assigning `src` to a live iframe pushes an
entry onto the parent's history and quietly breaks the back button. Closing removes the iframe
rather than hiding it, so the ad page stops running.

`@noframes` (plus a `window.top !== window.self` guard) keeps the script out of its own preview.
The ad page URL matches `@match` too, so without it the script runs inside the iframe and stacks a
second overlay in there.

## Development

`yad2-km-loader.user.js` is a paste-once loader so you never have to re-paste the real script
into Tampermonkey while iterating. Install it instead of the main script, then:

```bash
cd ~/yad2-km-dev && python3 -m http.server 8137 --bind 127.0.0.1
```

Now editing `yad2-km-on-search.user.js` and reloading the page is the whole cycle.

It's served over HTTP rather than read via `file://` because Tampermonkey's `GM_xmlhttpRequest`
refuses `file://` URLs even when Chrome's "Allow access to file URLs" is enabled. The server binds
to `127.0.0.1`, so it isn't reachable from the network — but note it serves the whole directory,
and the loader executes whatever that file contains. Use the loader for development; install the
script directly for daily use.

## License

MIT
