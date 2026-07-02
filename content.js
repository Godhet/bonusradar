// Bonusradar – Content Script
// Matches current page against cached partner index and renders a chip widget.
// Re-runs on SPA URL changes via popstate + pushState monkey-patch.

const PORTAL_HOME = "https://onlineshopping.flysas.com/";
// How long a detected click-through counts as "tracked" for. Affiliate
// attribution windows are time-limited, not permanent — without this, a
// single genuine (or falsely detected) hit would mark a host tracked forever.
const TRACKED_TTL_MS = 24 * 60 * 60 * 1000;

// ---- Storage proxy helpers (content scripts cannot call storage.*) ----

function getStore(keys) {
  return browser.runtime.sendMessage({ type: "eb-storage-get", keys });
}

function setStore(data) {
  return browser.runtime.sendMessage({ type: "eb-storage-set", data });
}

// ---- Widget rendering ----

let chipEl = null;
let activeHost = null; // remember which host the chip belongs to

// Check if we arrived via the EuroBonus portal (loyaltykey redirect).
// Referrer is unreliable — it's dropped the moment you click a link on the
// partner site — so it's a best-effort supplement to the URL-param check below.
function cameFromPortal() {
  try {
    return document.referrer.includes("loyaltykey.com");
  } catch { return false; }
}

// Check if the landing URL carries SAS/LoyaltyKey affiliate tracking params.
// The redirect chain (loyaltykey -> TradeDoubler/Awin/Adtraction -> partner)
// deposits these on the partner page, e.g.:
//   ?affId=...&utm_source=tradedoubler&utm_medium=affiliate
//    &utm_campaign=Onlineshopping.flysas%20(SE)&tduid=...
// The gold signal is a campaign naming the SAS portal; the network click-id
// path is a fallback that requires an affiliate utm to avoid false positives.
function cameViaAffiliateLink() {
  try {
    const raw = new URLSearchParams(location.search);
    // Case-insensitive param lookup — networks vary the casing (affId, tduid…).
    const params = new Map();
    for (const [k, v] of raw) params.set(k.toLowerCase(), v);
    const get = (k) => params.get(k) || "";

    const campaign = get("utm_campaign").toLowerCase();
    // SAS's portal (Onlineshopping.flysas) shows up in the campaign name across
    // every network — the strongest, SAS-specific signal.
    if (campaign.includes("flysas") || campaign.includes("onlineshopping")) {
      return true;
    }

    const source = get("utm_source").toLowerCase();
    const hasAffiliateUtm =
      get("utm_medium").toLowerCase().includes("affiliate") ||
      ["tradedoubler", "awin", "adtraction", "partnerads", "adservice"].includes(source);
    const hasClickId =
      params.has("tduid") ||  // TradeDoubler
      params.has("affid") ||
      params.has("awc") ||    // Awin
      params.has("at_gd");    // Adtraction
    return hasAffiliateUtm && hasClickId;
  } catch { return false; }
}

async function getActiveCountry() {
  const store = await getStore(["country"]);
  return (store && store.country) || detectCountry();
}

async function checkAndRender() {
  const currentHost = normalizeHost(location.hostname);
  if (!currentHost) return;

  // If we're still on the same partner page, no need to re-check
  if (currentHost === activeHost && chipEl) return;
  // Navigated away from the partner – tear down existing chip
  if (activeHost !== currentHost && chipEl) {
    chipEl.remove();
    chipEl = null;
    activeHost = null;
  }

  const store = await getStore(["index", "hidden", "adblockActive"]);
  if (!store || !store.index) return;

  const host = normalizeHost(location.hostname);
  if (host && store.hidden && store.hidden.includes(host)) return;

  const country = await getActiveCountry();
  const hit = matchPartner(location.hostname, location.pathname, store.index, country);
  if (!hit) {
    activeHost = currentHost;
    return;
  }

  // Track whether we came via portal this session. Persist in storage so it
  // survives within-site navigation (both the referrer and the URL params
  // disappear once you click around the partner site after landing).
  let isTracked = cameFromPortal() || cameViaAffiliateLink();
  if (isTracked) {
    await setStore({ [`tracked:${host}`]: Date.now() });
  } else {
    const trackedStore = await getStore([`tracked:${host}`]);
    const trackedAt = trackedStore && trackedStore[`tracked:${host}`];
    isTracked = typeof trackedAt === "number" && Date.now() - trackedAt < TRACKED_TTL_MS;
  }

  // Best-effort enrichment: points + the tracked clickthrough URL.
  let detail = null;
  try {
    detail = await browser.runtime.sendMessage({
      type: "eb-detail",
      id: hit.id,
      country: hit.country,
    });
  } catch (_) {}

  // LOG: show both tracking signals so tracked-state can be debugged.
  console.log(
    `[Bonusradar] tracking debug — host: ${host}, country: ${hit.country}, ` +
      `referrer: "${document.referrer}", cameFromPortal: ${cameFromPortal()}, ` +
      `cameViaAffiliateLink: ${cameViaAffiliateLink()}`
  );

  const name = (detail && detail.name) || hit.domain;
  const points =
    detail && detail.points
      ? detail.commissionType === "fixed"
        ? `${detail.points} pts`
        : `${detail.points} pts / 100 kr`
      : "";
  const href = (detail && detail.url) || PORTAL_HOME;

  // Appearance depends on whether we're in a tracked session.
  const bgColor = isTracked ? "#136e2b" : "#2f6fed";
  const borderColor = isTracked ? "#1e9e3d" : "#6ea1f7";

  const chip = document.createElement("div");
  chip.id = "bonusradar-chip";
  Object.assign(chip.style, {
    position: "fixed", top: "12px", right: "12px", zIndex: "2147483647",
    display: "flex", alignItems: "center", gap: "8px",
    background: bgColor, color: "#fff", padding: "8px 10px 8px 12px",
    borderRadius: "10px", font: "13px/1.3 system-ui, -apple-system, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,.35)", border: `1px solid ${borderColor}`,
  });

  if (isTracked) {
    // Green badge: telling the user they're being tracked.
    const statusEl = document.createElement("span");
    statusEl.textContent = `✅ ${name}${points ? ` · ${points}` : ""} — EuroBonus tracking active!`;
    Object.assign(statusEl.style, { color: "#fff", fontWeight: "600" });
    chip.append(statusEl);
  } else {
    // Blue link: call to action to go via portal.
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `★ ${name}${points ? ` · ${points}` : ""} — shop via EuroBonus portal`;
    Object.assign(link.style, { color: "#fff", textDecoration: "none", fontWeight: "600" });
    chip.append(link);

    // Only warn when we've actually detected a blocked affiliate network —
    // never a blanket "you have an adblocker" nag, and never once tracking
    // has already been proven to work (that's the green state, above).
    if (store.adblockActive) {
      const warn = document.createElement("span");
      warn.textContent = "⚠️";
      warn.title =
        "Ad blocker detected that may block bonus tracking. If the badge " +
        "doesn't turn green after shopping, try allowing this site in your " +
        "ad blocker.";
      Object.assign(warn.style, { cursor: "help", fontSize: "12px" });
      chip.append(warn);
    }
  }

  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Hide on this site";
  Object.assign(close.style, {
    background: "transparent", color: isTracked ? "#a3e4b6" : "#aab4ee", border: "0",
    cursor: "pointer", font: "13px system-ui", padding: "0 2px", lineHeight: "1",
  });
  close.addEventListener("click", async () => {
    const hiddenStore = await getStore(["hidden"]);
    const hiddenList = (hiddenStore && hiddenStore.hidden) || [];
    if (!hiddenList.includes(host)) {
      await setStore({ hidden: [...hiddenList, host] });
    }
    chip.remove();
    chipEl = null;
  });
  chip.append(close);

  document.documentElement.appendChild(chip);

  chipEl = chip;
  activeHost = currentHost;
}

// ---- SPA Navigation support ----

let lastUrl = location.href;

function onUrlChange() {
  if (lastUrl === location.href) return;
  lastUrl = location.href;
  checkAndRender();
}

window.addEventListener("popstate", onUrlChange);

// Monkey-patch history methods to catch SPA pushes/replaces
const _pushState = history.pushState;
const _replaceState = history.replaceState;
history.pushState = function () {
  _pushState.apply(this, arguments);
  requestAnimationFrame(onUrlChange);
};
history.replaceState = function () {
  _replaceState.apply(this, arguments);
  requestAnimationFrame(onUrlChange);
};

// React immediately when the popup changes the active country.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "eb-country-changed") {
    if (chipEl) {
      chipEl.remove();
      chipEl = null;
    }
    activeHost = null;
    checkAndRender();
  }
});

// ---- Initial render ----

checkAndRender();
