// Theme toggle. The CSS does the actual work through light-dark() keyed on `color-scheme`;
// all this does is set (or clear) the data-theme attribute that overrides the system
// preference, and remember the choice.
//
// Browser-side ES module, also imported by node:test. The two functions that decide anything
// are pure and tested; initTheme below is thin DOM glue.
//
// Storage key: NOT hardcoded here. server.js owns it and hands it in, because the inline
// bootstrap in <head> needs the same string and the two would otherwise be separate literals
// free to drift - a bug that shows up as "my theme choice survives a reload sometimes".

/** What is actually on screen right now. `explicit` is the data-theme attribute, or null. */
export function resolveTheme(explicit, prefersDark) {
  if (explicit === "dark" || explicit === "light") return explicit;
  return prefersDark ? "dark" : "light";
}

// Two states, never three. Offering a way back to "follow the system" means a toggle whose
// click does nothing visible one time in three, which reads as a bug rather than a feature.
export function nextTheme(current) {
  return current === "dark" ? "light" : "dark";
}

export function initTheme({ root, storageKey, toggles, prefersDark, storage }) {
  const apply = (theme) => {
    root.setAttribute("data-theme", theme);
    try {
      storage?.setItem(storageKey, theme);
    } catch {
      // Private browsing, or storage disabled. The theme still applies for this page; it just
      // won't be remembered, which is a far better outcome than throwing here.
    }
  };
  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      apply(nextTheme(resolveTheme(root.getAttribute("data-theme"), prefersDark())));
    });
  }
}
