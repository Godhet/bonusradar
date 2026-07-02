// Bonusradar – Popup
// Lets the user override the auto-detected home country. Popup pages run in
// the extension context, so unlike content scripts they can call storage.*
// directly.

const COUNTRY_NAME = { SE: "Sweden", NO: "Norway", DK: "Denmark" };

const select = document.getElementById("country");
const statusEl = document.getElementById("status");

async function init() {
  const { country, counts } = await browser.storage.local.get(["country", "counts"]);
  select.value = country || "";
  renderStatus(country, counts);
}

function renderStatus(country, counts) {
  const active = country || detectCountry();
  const label = COUNTRY_NAME[active] || active;
  const n = counts && counts[active];
  statusEl.textContent = country
    ? `Using ${label}${n ? ` (${n} shops)` : ""}.`
    : `Auto-detected: ${label}${n ? ` (${n} shops)` : ""}. Change above if that's wrong.`;
}

select.addEventListener("change", async () => {
  const value = select.value || null; // "" -> auto-detect, stored as absence of key
  if (value) {
    await browser.storage.local.set({ country: value });
  } else {
    await browser.storage.local.remove("country");
  }

  const { counts } = await browser.storage.local.get("counts");
  renderStatus(value, counts);

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) browser.tabs.sendMessage(tab.id, { type: "eb-country-changed" }).catch(() => {});
  } catch (_) {}
});

init();
