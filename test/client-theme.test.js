import assert from "node:assert/strict";
import test from "node:test";

import { initTheme, nextTheme, resolveTheme } from "../src/client/theme.js";

test("resolveTheme: an explicit choice wins over the system preference, in both directions", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("resolveTheme: with no explicit choice, the system preference decides", () => {
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(null, false), "light");
  assert.equal(resolveTheme("", true), "dark");
  assert.equal(resolveTheme("garbage", false), "light");
});

test("nextTheme is a two-state flip - there is no way back to following the system", () => {
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
});

// A stub root/button/storage triple - enough DOM shape for initTheme, no jsdom needed.
function harness({ attr = null, prefersDark = false, storage } = {}) {
  const handlers = [];
  const root = {
    getAttribute: () => attr,
    setAttribute: (name, value) => {
      if (name === "data-theme") attr = value;
    },
  };
  const toggle = { addEventListener: (event, fn) => event === "click" && handlers.push(fn) };
  initTheme({ root, storageKey: "k", toggles: [toggle], prefersDark: () => prefersDark, storage });
  return { click: () => handlers.forEach((fn) => fn()), current: () => attr };
}

test("clicking flips away from whatever is currently showing, system preference included", () => {
  const fromSystemDark = harness({ attr: null, prefersDark: true });
  fromSystemDark.click();
  assert.equal(fromSystemDark.current(), "light", "system dark + click should go light");

  const fromSystemLight = harness({ attr: null, prefersDark: false });
  fromSystemLight.click();
  assert.equal(fromSystemLight.current(), "dark", "system light + click should go dark");
});

test("clicking twice returns to where it started", () => {
  const h = harness({ attr: "dark", prefersDark: true });
  h.click();
  assert.equal(h.current(), "light");
  h.click();
  assert.equal(h.current(), "dark");
});

test("the choice is written to storage under the key it was given", () => {
  const written = [];
  const h = harness({ attr: "dark", prefersDark: true, storage: { setItem: (k, v) => written.push([k, v]) } });
  h.click();
  assert.deepEqual(written, [["k", "light"]]);
});

// Private browsing throws on setItem. Losing the preference is a nuisance; throwing here would
// abort the module and take the rest of the page's wiring down with it.
test("storage that throws does not stop the theme from applying", () => {
  const h = harness({
    attr: "dark",
    storage: {
      setItem() {
        throw new Error("storage disabled");
      },
    },
  });
  assert.doesNotThrow(() => h.click());
  assert.equal(h.current(), "light");
});

test("a missing storage object is tolerated", () => {
  const h = harness({ attr: "light", storage: undefined });
  assert.doesNotThrow(() => h.click());
  assert.equal(h.current(), "dark");
});
