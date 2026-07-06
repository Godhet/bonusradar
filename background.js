// In Chrome the background runs as a service worker, which loads a single
// file — so it must pull in its dependencies itself. In Firefox the manifest
// lists these in `background.scripts` and importScripts is undefined here, so
// this is skipped. Must run before any browser.* / match-helper use below.
if (typeof importScripts === "function") {
  importScripts("lib/compat.js", "lib/match.js");
}

// ===================== CONFIG =====================
const API_BASE = "https://onlineshopping.loyaltykey.com/api/browser-extension/sas";
// EuroBonus covers Sweden, Norway and Denmark on LoyaltyKey's API. All three
// are fetched and merged; COUNTRY_LOCALE comes from lib/match.js.
const REFRESH_MINUTES = 1440; // refresh the shop lists once a day
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
// Affiliate networks LoyaltyKey's redirect chain routes through (the same
// ones content.js's cameViaAffiliateLink() recognizes by utm_source). We
// can't tell in advance which one a given shop uses — the portal resolves
// that client-side at click time — so this bait-checks all of them.
const AD_NETWORK_HOSTS = [
  "tradedoubler.com",
  "awin1.com",
  "dwin1.com",
  "adtraction.com",
  "partner-ads.com",
  "adservice.com",
];
// A host no content/ad blocker would touch (we already have permission for it).
// Used as a control: if even this can't be reached, the machine is offline and
// the probe is inconclusive — so we don't mistake "no network" for "blocked".
const CONTROL_HOST = "onlineshopping.loyaltykey.com";
const BAIT_TIMEOUT_MS = 4000;
// =================================================

async function fetchShopList(locale) {
  try {
    const res = await fetch(`${API_BASE}/${locale}/shops`, { credentials: "omit" });
    if (!res.ok) return null;
    const map = await res.json();
    if (map && typeof map === "object" && Object.keys(map).length > 0) return map;
  } catch (_) {
    // network hiccup, treated as "no data for this country" below
  }
  return null;
}

async function refresh() {
  const counts = {};
  const perCountryIndex = [];

  for (const country of Object.keys(COUNTRY_LOCALE)) {
    const map = await fetchShopList(COUNTRY_LOCALE[country]);
    if (!map) {
      console.warn(`[Bonusradar] could not load the shop list for ${country}`);
      continue;
    }
    counts[country] = Object.keys(map).length;
    perCountryIndex.push(buildIndex(map, country));
  }

  if (perCountryIndex.length === 0) {
    console.warn("[Bonusradar] could not load any shop list");
    return;
  }

  const index = mergeIndices(...perCountryIndex);
  await browser.storage.local.set({ index, counts, fetchedAt: Date.now() });
  console.log(
    `[Bonusradar] loaded shops — ${Object.entries(counts)
      .map(([c, n]) => `${c}: ${n}`)
      .join(", ")}; adlibris.com present: ${!!index["adlibris.com"]}`
  );
}

// Bait-check: a bare no-cors fetch to a host. Returns true if the request
// couldn't go out at all (a blocker intercepted it, OR the host is
// unreachable/renamed/offline — a no-cors fetch can't tell those apart, which
// is why checkAdblock() below uses a control host and a majority threshold
// rather than trusting a single probe). A timeout also counts as "didn't go
// out". We only care whether it left, not what came back.
async function probeBlocked(host) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BAIT_TIMEOUT_MS);
  try {
    await fetch(`https://${host}/`, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return false; // request went out — not blocked
  } catch (_) {
    return true; // blocked, unreachable, or timed out
  } finally {
    clearTimeout(timer);
  }
}

async function checkAdblock() {
  // If we can't even reach a host nothing would block, the network is down —
  // inconclusive, so leave the previous state alone rather than false-warning.
  if (await probeBlocked(CONTROL_HOST)) return;

  const results = await Promise.all(AD_NETWORK_HOSTS.map(probeBlocked));
  const blocked = results.filter(Boolean).length;
  // A real content blocker blocks essentially all of these at once. Requiring a
  // majority means one renamed/unreachable domain can't trigger a false warning.
  const adblockActive = blocked >= Math.ceil(AD_NETWORK_HOSTS.length / 2);
  await browser.storage.local.set({ adblockActive, adblockCheckedAt: Date.now() });
  console.log(
    `[Bonusradar] ad-blocker probe — ${blocked}/${AD_NETWORK_HOSTS.length} blocked; warning: ${adblockActive}`
  );
}

// Per-shop detail: points + the tracked clickthrough URL. Cached in storage.
async function getDetail(id, country) {
  const locale = COUNTRY_LOCALE[country] || COUNTRY_LOCALE.SE;
  const key = `bonusradar-detail:${country}:${id}`;
  try {
    const cached = await browser.storage.local.get(key);
    if (cached[key] && Date.now() - cached[key].at < DETAIL_TTL_MS) {
      return cached[key].v;
    }
  } catch (_) {}

  try {
    const res = await fetch(`${API_BASE}/${locale}/shops/${encodeURIComponent(id)}`, {
      credentials: "omit",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const d = json && json.data;
    if (!d) return null;
    const v = {
      name: d.name,
      points: Number(d.points) || 0,
      commissionType: d.commission_type,
      url: d.url, // the tracked "shop now" clickthrough
    };
    await browser.storage.local.set({ [key]: { at: Date.now(), v } });
    return v;
  } catch (e) {
    console.warn("[Bonusradar] detail fetch failed for", country, id, e);
    return null;
  }
}

// ---- Message handlers ----
function refreshAll() {
  refresh();
  checkAdblock();
}
browser.runtime.onInstalled.addListener(refreshAll);
browser.runtime.onStartup.addListener(refreshAll);
// Create the alarm only if it doesn't already exist. This top-level code re-runs
// every time the service worker / event page wakes (which is often — content
// scripts wake it on page loads); calling alarms.create unconditionally would
// reset the 24h countdown each time, so the periodic refresh would rarely fire.
browser.alarms.get("bonusradar-refresh").then((existing) => {
  if (!existing) {
    browser.alarms.create("bonusradar-refresh", { periodInMinutes: REFRESH_MINUTES });
  }
});
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "bonusradar-refresh") refreshAll();
});

async function handleMessage(msg) {
  // Shop detail request from content script
  if (msg && msg.type === "eb-detail") {
    return await getDetail(msg.id, msg.country);
  }

  // Storage proxy: content scripts can't call storage.* directly
  if (msg && msg.type === "eb-storage-get") {
    return await browser.storage.local.get(msg.keys);
  }

  if (msg && msg.type === "eb-storage-set") {
    await browser.storage.local.set(msg.data);
    return true;
  }

  return undefined;
}

// Return true + call sendResponse asynchronously. Firefox also accepts a
// Promise returned directly from the listener, but Chrome does NOT — it drops
// the value, leaving the sender's sendMessage promise unresolved. The
// return-true + sendResponse pattern is the only one that works in both.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse, (err) => {
    console.warn("[Bonusradar] message handler failed", err);
    sendResponse(null);
  });
  return true;
});
