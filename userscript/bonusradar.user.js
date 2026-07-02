// ==UserScript==
// @name         Bonusradar
// @namespace    https://github.com/Godhet/bonusradar
// @version      0.3.1
// @description  Flags SAS EuroBonus partner shops in Sweden, Norway and Denmark as you browse, with a link to shop via the portal so you actually earn points.
// @author       Marcus Palmqvist
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @homepageURL  https://github.com/Godhet/bonusradar
// @updateURL    https://raw.githubusercontent.com/Godhet/bonusradar/main/userscript/bonusradar.user.js
// @downloadURL  https://raw.githubusercontent.com/Godhet/bonusradar/main/userscript/bonusradar.user.js
// @license      MIT
// ==/UserScript==

// Userscript build for browsers without extension support (e.g. iOS Safari via
// the "Userscripts" app). Same matching logic as the Firefox extension
// (lib/match.js), but copied in directly rather than loaded via @require —
// some userscript managers' sandboxed contexts don't reliably fetch remote
// @require scripts, which fails silently (no console visible on iOS) and
// looks exactly like "the script just does nothing". Keeping this
// self-contained removes that whole failure class. If you change the
// matching logic in lib/match.js, mirror the change here too.
//
// GM_getValue/GM_setValue are awaited everywhere: some managers (Tampermonkey,
// Violentmonkey) return values synchronously, others (Userscripts on iOS)
// return a Promise. Awaiting a plain value just resolves immediately, so this
// works either way.

(function () {
  "use strict";

  // ---- Matching logic (mirrors lib/match.js) ----

  const COUNTRY_LOCALE = { SE: "sv-SE", NO: "nb-NO", DK: "da-DK" };

  function normalizeHost(input) {
    if (!input) return null;
    try {
      const s = String(input);
      const url = new URL(s.startsWith("http") ? s : "https://" + s);
      return url.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return String(input).replace(/^www\./, "").toLowerCase() || null;
    }
  }

  function parseShopKey(key) {
    const trimmed = String(key).trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!trimmed) return null;
    const slash = trimmed.indexOf("/");
    const rawHost = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const path = slash === -1 ? "" : trimmed.slice(slash);
    const domain = rawHost.replace(/^www\./, "");
    return domain ? { domain, path } : null;
  }

  function buildIndex(rawMap, country) {
    const index = {};
    for (const key in rawMap) {
      const parsed = parseShopKey(key);
      if (!parsed) continue;
      (index[parsed.domain] = index[parsed.domain] || []).push({
        id: rawMap[key],
        path: parsed.path,
        country: country || null,
      });
    }
    return index;
  }

  function mergeIndices(...indices) {
    const merged = {};
    for (const idx of indices) {
      if (!idx) continue;
      for (const domain in idx) {
        merged[domain] = (merged[domain] || []).concat(idx[domain]);
      }
    }
    return merged;
  }

  function matchPartner(host, path, index, preferredCountry) {
    const h = normalizeHost(host);
    if (!h || !index) return null;

    const candidates = [h];
    const parts = h.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      candidates.push(parts.slice(i).join("."));
    }

    const p = (path || "/").toLowerCase();

    const pickFrom = (entries) => {
      if (!entries || !entries.length) return null;
      const scoped = entries.filter((e) => e.path && p.startsWith(e.path));
      const pool = scoped.length ? scoped : entries.filter((e) => !e.path);
      if (!pool.length) return null;
      if (preferredCountry) {
        const preferred = pool.find((e) => e.country === preferredCountry);
        if (preferred) return preferred;
      }
      return pool[0];
    };

    for (const c of candidates) {
      const hit = pickFrom(index[c]);
      if (hit) return { id: hit.id, domain: c, country: hit.country };
    }
    return null;
  }

  function detectCountry() {
    try {
      const lang = (
        (typeof navigator !== "undefined" &&
          (navigator.language || (navigator.languages && navigator.languages[0]))) ||
        ""
      ).toLowerCase();
      if (lang.startsWith("da")) return "DK";
      if (lang.startsWith("nb") || lang.startsWith("nn") || lang.startsWith("no")) return "NO";
      if (lang.startsWith("sv")) return "SE";
    } catch {}
    return "SE";
  }

  // ---- Config ----

  const API_BASE = "https://onlineshopping.loyaltykey.com/api/browser-extension/sas";
  const PORTAL_HOME = "https://onlineshopping.flysas.com/";
  const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
  const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
  const TRACKED_TTL_MS = 24 * 60 * 60 * 1000;
  const ADBLOCK_TTL_MS = 24 * 60 * 60 * 1000;
  const BAIT_TIMEOUT_MS = 4000;
  // Same networks the Firefox extension bait-checks — see background.js for why.
  const AD_NETWORK_HOSTS = [
    "tradedoubler.com",
    "awin1.com",
    "dwin1.com",
    "adtraction.com",
    "partnerads.no",
    "adservice.com",
  ];
  const COUNTRY_NAMES = { SE: "Sweden", NO: "Norway", DK: "Denmark" };

  // ---- Shop list + index (mirrors background.js's refresh(), run inline) ----

  async function fetchShopList(locale) {
    try {
      const res = await fetch(`${API_BASE}/${locale}/shops`, { credentials: "omit" });
      if (!res.ok) return null;
      const map = await res.json();
      if (map && typeof map === "object" && Object.keys(map).length > 0) return map;
    } catch (_) {}
    return null;
  }

  async function ensureIndex() {
    const fetchedAt = (await GM_getValue("fetchedAt", 0)) || 0;
    let index = await GM_getValue("index", null);
    if (index && Date.now() - fetchedAt < INDEX_TTL_MS) return index;

    const counts = {};
    const perCountryIndex = [];
    for (const country of Object.keys(COUNTRY_LOCALE)) {
      const map = await fetchShopList(COUNTRY_LOCALE[country]);
      if (!map) continue;
      counts[country] = Object.keys(map).length;
      perCountryIndex.push(buildIndex(map, country));
    }

    if (perCountryIndex.length === 0) return index; // keep stale data over nothing

    index = mergeIndices(...perCountryIndex);
    await GM_setValue("index", index);
    await GM_setValue("counts", counts);
    await GM_setValue("fetchedAt", Date.now());
    return index;
  }

  async function getDetail(id, country) {
    const locale = COUNTRY_LOCALE[country] || COUNTRY_LOCALE.SE;
    const key = `detail:${country}:${id}`;
    const cached = await GM_getValue(key, null);
    if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.v;

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
        url: d.url,
      };
      await GM_setValue(key, { at: Date.now(), v });
      return v;
    } catch (_) {
      return null;
    }
  }

  // ---- Ad-blocker bait check (mirrors background.js's checkAdblock()) ----

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
      return false;
    } catch (e) {
      return e.name !== "AbortError";
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureAdblockStatus() {
    const checkedAt = (await GM_getValue("adblockCheckedAt", 0)) || 0;
    if (Date.now() - checkedAt < ADBLOCK_TTL_MS) {
      return await GM_getValue("adblockActive", false);
    }
    const results = await Promise.all(AD_NETWORK_HOSTS.map(probeHost));
    const adblockActive = results.some(Boolean);
    await GM_setValue("adblockActive", adblockActive);
    await GM_setValue("adblockCheckedAt", Date.now());
    return adblockActive;
  }

  // ---- Portal-tracking detection (identical to content.js) ----

  function cameFromPortal() {
    try {
      return document.referrer.includes("loyaltykey.com");
    } catch { return false; }
  }

  function cameViaAffiliateLink() {
    try {
      const raw = new URLSearchParams(location.search);
      const params = new Map();
      for (const [k, v] of raw) params.set(k.toLowerCase(), v);
      const get = (k) => params.get(k) || "";

      const campaign = get("utm_campaign").toLowerCase();
      if (campaign.includes("flysas") || campaign.includes("onlineshopping")) return true;

      const source = get("utm_source").toLowerCase();
      const hasAffiliateUtm =
        get("utm_medium").toLowerCase().includes("affiliate") ||
        ["tradedoubler", "awin", "adtraction", "partnerads", "adservice"].includes(source);
      const hasClickId =
        params.has("tduid") || params.has("affid") || params.has("awc") || params.has("at_gd");
      return hasAffiliateUtm && hasClickId;
    } catch { return false; }
  }

  // ---- Country selection (popup dropdown -> menu commands) ----

  async function getActiveCountry() {
    const override = await GM_getValue("country", "");
    return override || detectCountry();
  }

  async function registerCountryMenu() {
    const current = (await GM_getValue("country", "")) || "";
    const label = current
      ? `Bonusradar: country = ${COUNTRY_NAMES[current]} (tap to change)`
      : `Bonusradar: country = Auto (${COUNTRY_NAMES[detectCountry()]}) (tap to change)`;

    GM_registerMenuCommand(label, async () => {
      const input = window.prompt(
        "Bonusradar home country.\nType SE, NO or DK — or leave blank for auto-detect.",
        current
      );
      if (input === null) return;
      const normalized = input.trim().toUpperCase();
      if (normalized && !COUNTRY_LOCALE[normalized]) {
        window.alert(`"${input}" isn't a supported country. Use SE, NO, DK, or leave blank.`);
        return;
      }
      await GM_setValue("country", normalized);
      window.location.reload();
    });
  }

  // ---- Widget rendering: full-width top banner ----

  let chipEl = null;
  let activeHost = null;

  async function checkAndRender() {
    const currentHost = normalizeHost(location.hostname);
    if (!currentHost) return;

    if (currentHost === activeHost && chipEl) return;
    if (activeHost !== currentHost && chipEl) {
      chipEl.remove();
      chipEl = null;
      activeHost = null;
    }

    const index = await ensureIndex();
    if (!index) return;

    const host = normalizeHost(location.hostname);
    const hidden = (await GM_getValue("hidden", [])) || [];
    if (host && hidden.includes(host)) return;

    const country = await getActiveCountry();
    const hit = matchPartner(location.hostname, location.pathname, index, country);
    if (!hit) {
      activeHost = currentHost;
      return;
    }

    const trackedKey = `tracked:${host}`;
    let isTracked = cameFromPortal() || cameViaAffiliateLink();
    if (isTracked) {
      await GM_setValue(trackedKey, Date.now());
    } else {
      const trackedAt = await GM_getValue(trackedKey, null);
      isTracked = typeof trackedAt === "number" && Date.now() - trackedAt < TRACKED_TTL_MS;
    }

    const detail = await getDetail(hit.id, hit.country);
    const adblockActive = isTracked ? false : await ensureAdblockStatus();

    const name = (detail && detail.name) || hit.domain;
    const points =
      detail && detail.points
        ? detail.commissionType === "fixed"
          ? `${detail.points} pts`
          : `${detail.points} pts / 100 kr`
        : "";
    const href = (detail && detail.url) || PORTAL_HOME;

    const bgColor = isTracked ? "#136e2b" : "#2f6fed";
    const borderColor = isTracked ? "#1e9e3d" : "#6ea1f7";

    const chip = document.createElement("div");
    chip.id = "bonusradar-chip";
    Object.assign(chip.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647",
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: "8px", background: bgColor, color: "#fff", padding: "10px 44px",
      font: "14px/1.4 system-ui, -apple-system, sans-serif", textAlign: "center",
      boxShadow: "0 2px 12px rgba(0,0,0,.3)", borderBottom: `1px solid ${borderColor}`,
    });

    if (isTracked) {
      const statusEl = document.createElement("span");
      statusEl.textContent = `✅ ${name}${points ? ` · ${points}` : ""} — EuroBonus tracking active!`;
      Object.assign(statusEl.style, { color: "#fff", fontWeight: "600" });
      chip.append(statusEl);
    } else {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `★ ${name}${points ? ` · ${points}` : ""} — shop via EuroBonus portal`;
      Object.assign(link.style, { color: "#fff", textDecoration: "none", fontWeight: "600" });
      chip.append(link);

      if (adblockActive) {
        const warn = document.createElement("span");
        warn.textContent = "⚠️";
        warn.title =
          "Ad blocker detected that may block bonus tracking. If the badge " +
          "doesn't turn green after shopping, try allowing this site in your " +
          "ad blocker / content blocker.";
        Object.assign(warn.style, { cursor: "help", fontSize: "12px" });
        chip.append(warn);
      }
    }

    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Hide on this site";
    Object.assign(close.style, {
      position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)",
      background: "transparent", color: isTracked ? "#a3e4b6" : "#aab4ee", border: "0",
      cursor: "pointer", font: "16px system-ui", padding: "4px", lineHeight: "1",
    });
    close.addEventListener("click", async () => {
      const hiddenList = (await GM_getValue("hidden", [])) || [];
      if (!hiddenList.includes(host)) {
        await GM_setValue("hidden", [...hiddenList, host]);
      }
      chip.remove();
      chipEl = null;
    });
    chip.append(close);

    document.documentElement.appendChild(chip);
    chipEl = chip;
    activeHost = currentHost;
  }

  // ---- SPA navigation support (identical to content.js) ----

  let lastUrl = location.href;
  function onUrlChange() {
    if (lastUrl === location.href) return;
    lastUrl = location.href;
    checkAndRender();
  }
  window.addEventListener("popstate", onUrlChange);
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

  // ---- Init ----

  registerCountryMenu();
  checkAndRender();
})();
