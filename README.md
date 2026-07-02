# Bonusradar

A Firefox (MV3) extension that shows a small widget when the site you're on is
a SAS EuroBonus shopping partner, with the points rate and a one-click link to
shop via the portal so you actually earn them. Covers all three EuroBonus
markets on LoyaltyKey's catalog: Sweden, Norway and Denmark.

## How it works

There is no bundled shop list to go stale. On install (and once a day) the
extension fetches the SAS partner catalog for all three markets straight from
LoyaltyKey's browser-extension API:

```
https://onlineshopping.loyaltykey.com/api/browser-extension/sas/<locale>/shops
```

(`sv-SE`, `nb-NO`, `da-DK`) — each returns a `{ "domain": "shopId" }` map. The
three maps are merged locally into one index; a domain that's a partner in
more than one market keeps a separate entry per market, since the shop id,
points rate and tracked clickthrough link are market-specific.

The current tab's hostname is matched **locally** against that index (so your
browsing isn't sent anywhere). Only when you're actually on a partner site
does it fetch that one shop's detail (`/shops/<shopId>`) to show the points
and the tracked clickthrough URL.

**Home country**: auto-detected from your browser's language (`sv` → Sweden,
`nb`/`nn`/`no` → Norway, `da` → Denmark, anything else defaults to Sweden).
Click the toolbar icon to override it — useful if a shop is a partner in more
than one market and you want the widget to use the tracked link for the
market you're actually a EuroBonus member in.

The widget has two states. **Blue** (with a "shop via EuroBonus portal" link)
means you're on a partner site but not in a tracked session. **Green**
("EuroBonus tracking active!") means you arrived via the portal and points
will actually track — detected from the affiliate params SAS leaves on the
landing URL (`utm_campaign` naming the flysas portal, or a network click-id
like `tduid`/`awc`/`at_gd` alongside an affiliate `utm_medium`), with
`document.referrer` as a supplementary hint.

## Load it in Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick the `.zip` (manifest is at the root)
3. Open the extension's console (Inspect on this Firefox page) — you should see
   a line like `loaded shops — SE: 454, NO: 236, DK: 272; adlibris.com present: true`
4. Visit `https://www.adlibris.com/sv` — the widget should appear as a bar
   across the top of the page.

> Temporary add-ons vanish on restart. To make it permanent, sign it: submit
> the zip to addons.mozilla.org as an **unlisted** add-on and self-install the
> signed `.xpi`, or set `xpinstall.signatures.required` to `false` on Firefox
> Developer/Nightly/ESR.

## iOS Safari (userscript)

Safari on iOS doesn't support browser extensions like Firefox does, but there's
a userscript build with the same matching logic at
[`userscript/bonusradar.user.js`](userscript/bonusradar.user.js) that runs via
a userscript manager.

1. Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)
   (free) from the App Store, then enable it under
   Settings → Safari → Extensions.
2. Open this link in Safari and tap **Install** when Userscripts prompts you:
   https://raw.githubusercontent.com/Godhet/bonusradar/main/userscript/bonusradar.user.js
3. Visit a partner site — the widget should appear as a bar across the top
   of the page.

The userscript has no background page, so the shop list refreshes
opportunistically (once a day, on whichever page you happen to be on) rather
than on a fixed timer. To change your home country, tap the Userscripts
extension icon and use the "Bonusradar: country = …" menu command.

## Privacy

Matching happens locally against the cached index. The extension talks to
LoyaltyKey only (a) once a day for the three market catalogs and (b) for a
single shop's detail when you land on a partner site — never the full list of
sites you visit. Detail requests are sent without credentials, so they're
anonymous.

## Tests

```
node test/match.test.js
```

## Notes & credit

The browser-extension API endpoint and response shapes were identified from the
open-source **BonusVarsler** project (github.com/kristofferR/BonusVarsler, GPL-3.0)
— thanks to them for charting the path. This extension shares no code with it;
it just calls the same public LoyaltyKey API. Not affiliated with SAS or
EuroBonus.

## License

MIT — see [LICENSE](LICENSE).

## Buy me a coffee?

No pressure, but if this saved you some EuroBonus points and you're feeling
generous: [ko-fi.com/socker](https://ko-fi.com/socker) ☕
