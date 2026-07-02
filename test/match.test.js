// Run with:  node test/match.test.js
const assert = require("assert");
const {
  buildIndex,
  mergeIndices,
  matchPartner,
  normalizeHost,
  parseShopKey,
} = require("../lib/match.js");

const seIndex = buildIndex(
  {
    "adlibris.com": "A-SE",
    "elgiganten.se": "E-SE",
    "brand.com/se": "BSE-SE",
    "brand.com": "B-SE",
  },
  "SE"
);
const noIndex = buildIndex(
  {
    "adlibris.com": "A-NO", // partner in both SE and NO, different shop id
    "elkjop.no": "ELK-NO",
  },
  "NO"
);
const index = mergeIndices(seIndex, noIndex);

// normalizeHost
assert.strictEqual(normalizeHost("www.Adlibris.com"), "adlibris.com");
assert.strictEqual(normalizeHost("https://store.nike.com/x"), "store.nike.com");

// parseShopKey
assert.deepStrictEqual(parseShopKey("www.Foo.com/SE"), { domain: "foo.com", path: "/se" });

// matching, no preferred country given -> first entry found
assert.strictEqual(matchPartner("www.elgiganten.se", "/x", index).id, "E-SE");
assert.strictEqual(matchPartner("notapartner.com", "/", index), null);

// path-scoped: /se goes to BSE, everything else to bare B
assert.strictEqual(matchPartner("brand.com", "/se/books", index, "SE").id, "BSE-SE");
assert.strictEqual(matchPartner("brand.com", "/other", index, "SE").id, "B-SE");

// multi-country: prefer the active country when a domain is a partner in more than one
assert.strictEqual(matchPartner("adlibris.com", "/", index, "SE").id, "A-SE");
assert.strictEqual(matchPartner("adlibris.com", "/", index, "NO").id, "A-NO");
// no preference for a country the domain isn't in -> falls back to whatever exists
assert.strictEqual(matchPartner("adlibris.com", "/", index, "DK").id, "A-SE");

// only listed in one country's catalog -> still matches regardless of active country
assert.strictEqual(matchPartner("www.elkjop.no", "/", index, "SE").id, "ELK-NO");

console.log("All matcher tests passed ✓");
