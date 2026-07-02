// Cross-browser namespace shim. Firefox exposes the Promise-based `browser.*`
// API; Chrome only exposes `chrome.*`. Chrome's MV3 `chrome.*` already returns
// Promises for every API this extension uses (storage, runtime, alarms, tabs),
// so aliasing `browser` to `chrome` is all that's needed — no polyfill.
//
// Loaded first in every context (content scripts, popup, and — via
// importScripts — the Chrome service worker) so all other files can use
// `browser.*` unchanged. No-op in Firefox, where `browser` already exists.
if (typeof globalThis.browser === "undefined") {
  globalThis.browser = globalThis.chrome;
}
