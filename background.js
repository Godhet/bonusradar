// ===================== CONFIG =====================
const API_BASE = "https://onlineshopping.loyaltykey.com/api/browser-extension/sas";
// EuroBonus covers Sweden, Norway and Denmark on LoyaltyKey's API. All three
// are fetched and merged; COUNTRY_LOCALE comes from lib/match.js.
const REFRESH_MINUTES = 1440; // refresh the shop lists once a day
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
// Affiliate networks LoyaltyKey's redirect chain routes through (the same
// ones content.js's cameViaAffiliateLink() recognizes by utm_source). We
// can't tell in advance which one a given shop uses — the portal resolves
// that client-side at click time — so this bait-checks all of them and only
// warns when at least one is actually blocked.
const AD_NETWORK_HOSTS = [
  "tradedoubler.com",
  "awin1.com",
  "dwin1.com",
  "adtraction.com",
  "partnerads.no",
  "adservice.com",
];
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

// Bait-check: try a bare no-cors fetch against each known ad-network host.
// If the browser's own network stack refuses the request (rather than the
// server responding, even with an error), a content/ad blocker is intercepting
// it — that's exactly what an opaque no-cors fetch is good for detecting,
// since we don't need to read the response, just whether it was allowed out.
// A timeout is treated as inconclusive, not blocked, to avoid false positives
// from an unrelated network hiccup.
async function probeHost(host) {
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
  } catch (e) {
    return e.name !== "AbortError"; // network-level rejection = blocked
  } finally {
    clearTimeout(timer);
  }
}

async function checkAdblock() {
  const results = await Promise.all(AD_NETWORK_HOSTS.map(probeHost));
  const adblockActive = results.some(Boolean);
  await browser.storage.local.set({ adblockActive, adblockCheckedAt: Date.now() });
  console.log(`[Bonusradar] ad-blocker probe — blocked networks detected: ${adblockActive}`);
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
browser.alarms.create("bonusradar-refresh", { periodInMinutes: REFRESH_MINUTES });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "bonusradar-refresh") refreshAll();
});

browser.runtime.onMessage.addListener(async (msg, sender) => {
  // Shop detail request from content script
  if (msg && msg.type === "eb-detail") {
    return await getDetail(msg.id, msg.country);
  }

  // Storage proxy: content scripts can't call storage.* directly
  if (msg && msg.type === "eb-storage-get") {
    const result = await browser.storage.local.get(msg.keys);
    return result;
  }

  if (msg && msg.type === "eb-storage-set") {
    await browser.storage.local.set(msg.data);
    return true;
  }
});
