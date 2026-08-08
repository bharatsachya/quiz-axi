// Browser-side ES module. Loaded directly by the review page (served at /client/text.js) and
// imported by node:test - the same code runs in both places, so what the tests cover is what
// ships.
//
// Deliberately duplicated with server.js's own escapeHtml: deduping would make the server
// import a browser module for twelve lines, inverting the dependency for no gain.
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}
