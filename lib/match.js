// Shared matching logic. Loads as a content/background script (attaches to
// globalThis) AND as a Node module for the test harness.
(function (root) {
  // EuroBonus covers Sweden, Norway and Denmark on LoyaltyKey's API today.
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

  // LoyaltyKey shop-map keys look like "adlibris.com" or, occasionally,
  // "brand.com/se" (a path-scoped sub-brand). Split into { domain, path }.
  function parseShopKey(key) {
    const trimmed = String(key).trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!trimmed) return null;
    const slash = trimmed.indexOf("/");
    const rawHost = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const path = slash === -1 ? "" : trimmed.slice(slash); // keeps leading "/"
    const domain = rawHost.replace(/^www\./, "");
    return domain ? { domain, path } : null;
  }

  // Turn one country's raw { key: shopId } response into
  // { domain: [{ id, path, country }] }, tagged with the country it came from
  // (a shop's id/detail/tracked-link is specific to the catalog it's in).
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

  // Combine several per-country indices (as built by buildIndex) into one.
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

  // Match current host (+ path) against the index. Handles www and subdomains
  // (store.nike.com -> nike.com) and path-scoped entries. When a domain is a
  // partner in more than one country's catalog, prefers preferredCountry (the
  // visitor's active country) but falls back to whichever is available so the
  // widget still shows for shops only listed elsewhere.
  // Returns { id, domain, country } or null.
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

  // Best-guess home country from the browser's language setting. Falls back
  // to SE (the largest catalog) when the language doesn't map to a supported
  // market; users can always override via the popup.
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

  const api = {
    COUNTRY_LOCALE,
    normalizeHost,
    parseShopKey,
    buildIndex,
    mergeIndices,
    matchPartner,
    detectCountry,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
