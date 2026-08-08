import assert from "node:assert/strict";
import test from "node:test";

import { anchorLabel, anchorRevealPlan, buildBlockAnchor, buildDiffAnchor, buildTextAnchor, resolveTextAnchor } from "../src/client/anchor.js";

const BLOCK = "The husky pre-push hook refuses git push for any diff that has not been reviewed and passed.";

test("buildTextAnchor records the quote plus context either side", () => {
  const start = BLOCK.indexOf("refuses git push");
  const anchor = buildTextAnchor({ blockId: "blk-step-0", blockKind: "walkthrough-step", blockText: BLOCK, start, end: start + 16 });
  assert.equal(anchor.kind, "text");
  assert.equal(anchor.exact, "refuses git push");
  assert.equal(anchor.block_id, "blk-step-0");
  assert.ok(anchor.prefix.endsWith("hook "));
  assert.ok(anchor.suffix.startsWith(" for any"));
});

test("resolveTextAnchor: the recorded offsets are used when they still hold", () => {
  const start = BLOCK.indexOf("refuses");
  const anchor = buildTextAnchor({ blockId: "b", blockKind: "k", blockText: BLOCK, start, end: start + 7 });
  assert.deepEqual(resolveTextAnchor(anchor, BLOCK), { start, end: start + 7, exact: "refuses" });
});

test("resolveTextAnchor: text inserted before the quote shifts it, and the quote is re-found", () => {
  const start = BLOCK.indexOf("refuses");
  const anchor = buildTextAnchor({ blockId: "b", blockKind: "k", blockText: BLOCK, start, end: start + 7 });
  const edited = `Note: ${BLOCK}`;
  const found = resolveTextAnchor(anchor, edited);
  assert.equal(edited.slice(found.start, found.end), "refuses");
  assert.equal(found.start, start + 6);
});

test("resolveTextAnchor: when the quote appears twice, surviving context picks the right one", () => {
  const text = "the gate blocks a push. later, the gate blocks a push again.";
  const second = text.lastIndexOf("blocks a push");
  const anchor = buildTextAnchor({ blockId: "b", blockKind: "k", blockText: text, start: second, end: second + 13 });
  // Something inserted at the very front shifts every offset, so tier 1 misses and both
  // occurrences are candidates - only the stored context distinguishes them.
  const edited = `X${text}`;
  const found = resolveTextAnchor(anchor, edited);
  assert.equal(found.start, second + 1, "should re-find the SECOND occurrence, not the first");
});

test("resolveTextAnchor: a quote that is gone entirely resolves to null", () => {
  const anchor = buildTextAnchor({ blockId: "b", blockKind: "k", blockText: BLOCK, start: 0, end: 5 });
  assert.equal(resolveTextAnchor(anchor, "completely different prose"), null);
});

test("resolveTextAnchor: an empty quote never matches", () => {
  assert.equal(resolveTextAnchor({ exact: "", start: 0, end: 0 }, BLOCK), null);
  assert.equal(resolveTextAnchor(null, BLOCK), null);
});

test("buildDiffAnchor: a selection inside one column becomes a line range on that side", () => {
  const anchor = buildDiffAnchor({
    hunkDomId: "hunk-3",
    file: "src/server.js",
    cells: [
      { side: "new", line: 120 },
      { side: "new", line: 121 },
      { side: "new", line: 122 },
    ],
  });
  assert.deepEqual(
    { side: anchor.side, start: anchor.start_line, end: anchor.end_line, whole: anchor.whole_hunk },
    { side: "new", start: 120, end: 122, whole: false },
  );
});

// The split view puts old and new in separate columns; a drag across both has no single line
// range, so widening to the hunk beats guessing which side was meant.
test("buildDiffAnchor: a selection crossing both columns degrades to the whole hunk", () => {
  const anchor = buildDiffAnchor({
    hunkDomId: "hunk-1",
    file: "a.js",
    cells: [
      { side: "old", line: 4 },
      { side: "new", line: 4 },
    ],
  });
  assert.equal(anchor.whole_hunk, true);
});

test("buildDiffAnchor: a selection reaching past the hunk degrades to the whole hunk", () => {
  const anchor = buildDiffAnchor({ hunkDomId: "hunk-1", file: "a.js", cells: [{ side: "new", line: 4 }], spansHunks: true });
  assert.equal(anchor.whole_hunk, true);
});

test("buildDiffAnchor: no addressable lines at all still yields a usable whole-hunk anchor", () => {
  const anchor = buildDiffAnchor({ hunkDomId: "hunk-2", file: "a.js", cells: [] });
  assert.equal(anchor.whole_hunk, true);
  assert.equal(anchor.hunk_dom_id, "hunk-2");
});

test("anchorLabel: prose is trimmed, diff anchors name their file and lines", () => {
  assert.equal(anchorLabel(buildBlockAnchor({ blockId: "b", blockKind: "k", blockText: "  a   b  " })), "a b");
  assert.equal(anchorLabel({ kind: "diff", file: "a.js", start_line: 4, end_line: 4 }), "a.js - line 4");
  assert.equal(anchorLabel({ kind: "diff", file: "a.js", start_line: 4, end_line: 9 }), "a.js - lines 4-9");
  assert.equal(anchorLabel({ kind: "diff", file: "a.js", whole_hunk: true }), "a.js - whole hunk");
  assert.equal(anchorLabel(null), "");
  assert.ok(anchorLabel({ kind: "text", exact: "x".repeat(200) }, 20).length <= 20);
});

// The tour relocates hunk and card nodes into its own shell and hides the full review, so
// "scroll to it" has three different right answers.
test("anchorRevealPlan: covers the three places an anchored node can be", () => {
  assert.deepEqual(anchorRevealPlan({ found: false, inFullReview: false, fullReviewHidden: true }), { action: "none" });
  assert.deepEqual(anchorRevealPlan({ found: true, inFullReview: true, fullReviewHidden: true }), { action: "exit-tour-then-scroll" });
  assert.deepEqual(anchorRevealPlan({ found: true, inFullReview: true, fullReviewHidden: false }), { action: "scroll" });
  // Relocated into the tour shell: already on screen, so leaving the tour would be wrong.
  assert.deepEqual(anchorRevealPlan({ found: true, inFullReview: false, fullReviewHidden: true }), { action: "scroll" });
});
