// Anchoring a human's question to the passage that prompted it.
//
// Derived from pi-teach's assets/runtime/anchor.mjs (MIT, (c) 2026 Josh Noll) - see NOTICE.
// Reduced on purpose. pi-teach re-finds a highlight by scoring how much of its surrounding
// context survived, because its lessons get rewritten underneath the anchor. quiz-axi's page
// is immutable within a session: the diff and quiz.json are fixed at review time, and any
// content change yields a new diffKey and a whole new session. So the offsets recorded here
// are simply correct, and the matching below is exact rather than fuzzy.
//
// The one case where text really does move under an anchor: re-running `review` with a
// corrected quiz.json against the SAME diff reuses the key and preserves the chat, so the
// explainer prose can change while an anchor points into it. That is what the fallback tiers
// and the `stale` flag exist for - not for general drift.
//
// Browser-side ES module, also imported by node:test. No DOM access in this file: callers pass
// plain text in and get plain data out.

/** Characters of context kept either side of the quote. Enough to disambiguate, cheap to store. */
export const ANCHOR_CONTEXT_LEN = 48;

/**
 * Build an anchor for `blockText.slice(start, end)`.
 * `blockId`/`blockKind` come from the server-stamped data-anchor-* attributes.
 */
export function buildTextAnchor({ blockId, blockKind, blockText, start, end }) {
  const exact = blockText.slice(start, end);
  return {
    kind: "text",
    block_id: blockId,
    block_kind: blockKind,
    start,
    end,
    exact,
    prefix: blockText.slice(Math.max(0, start - ANCHOR_CONTEXT_LEN), start),
    suffix: blockText.slice(end, Math.min(blockText.length, end + ANCHOR_CONTEXT_LEN)),
  };
}

/** Whole-block anchor: what a selection spanning two blocks degrades to, and what a stale text anchor becomes. */
export function buildBlockAnchor({ blockId, blockKind, blockText }) {
  return { kind: "block", block_id: blockId, block_kind: blockKind, exact: blockText };
}

/**
 * Build a diff anchor from the line cells a selection touched.
 *
 * Whole lines only, never a character range: the split view interleaves gutter numbers with
 * code in the same text flow, so an offset into a hunk's textContent means nothing. A
 * selection that crosses both columns, or that reaches past one hunk, degrades to the whole
 * hunk rather than being refused - the reader pointed at something, and the worst outcome is
 * pointing slightly wider than they meant.
 *
 * @param {{ hunkDomId: string, file: string, cells: Array<{ side: string, line: number }>, spansHunks?: boolean }} input
 */
export function buildDiffAnchor({ hunkDomId, file, cells, spansHunks = false }) {
  const sides = new Set(cells.map((cell) => cell.side));
  const lines = cells.map((cell) => cell.line).filter((line) => Number.isFinite(line));
  const wholeHunk = spansHunks || sides.size !== 1 || lines.length === 0;
  if (wholeHunk) {
    return { kind: "diff", hunk_dom_id: hunkDomId, file, side: "new", start_line: 0, end_line: 0, whole_hunk: true, exact: "" };
  }
  return {
    kind: "diff",
    hunk_dom_id: hunkDomId,
    file,
    side: [...sides][0],
    start_line: Math.min(...lines),
    end_line: Math.max(...lines),
    whole_hunk: false,
    exact: "",
  };
}

/**
 * Find where a text anchor's quote sits in the block's CURRENT text.
 *
 * Three tiers, cheapest first:
 *   1. the recorded offsets still hold - the normal case, and exact
 *   2. the quote appears exactly once elsewhere - the block was edited around it
 *   3. several candidates - pick the one whose stored context survived best
 *
 * Returns `{ start, end, exact }`, or null when the quote is gone entirely.
 */
export function resolveTextAnchor(anchor, blockText) {
  if (!anchor || typeof blockText !== "string") return null;
  const exact = String(anchor.exact ?? "");
  if (!exact) return null;

  if (blockText.slice(anchor.start, anchor.end) === exact) {
    return { start: anchor.start, end: anchor.end, exact };
  }

  const candidates = [];
  let at = blockText.indexOf(exact);
  while (at !== -1) {
    candidates.push(at);
    at = blockText.indexOf(exact, at + exact.length);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { start: candidates[0], end: candidates[0] + exact.length, exact };
  }

  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = contextScore(blockText, candidate, anchor, exact);
    // Strictly greater, so an exact tie keeps the earliest candidate rather than the last.
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { start: best, end: best + exact.length, exact };
}

/** How much of the anchor's stored neighbourhood still surrounds this candidate. */
function contextScore(blockText, candidateStart, anchor, exact) {
  const prefix = String(anchor.prefix ?? "");
  const suffix = String(anchor.suffix ?? "");
  const before = blockText.slice(Math.max(0, candidateStart - prefix.length), candidateStart);
  const after = blockText.slice(candidateStart + exact.length, candidateStart + exact.length + suffix.length);
  return commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/** Short human-readable label for a thread header or a pill. */
export function anchorLabel(anchor, maxLength = 80) {
  if (!anchor) return "";
  if (anchor.kind === "diff") {
    if (anchor.whole_hunk) return `${anchor.file} - whole hunk`;
    const range = anchor.start_line === anchor.end_line ? `line ${anchor.start_line}` : `lines ${anchor.start_line}-${anchor.end_line}`;
    return `${anchor.file} - ${range}`;
  }
  const text = String(anchor.exact || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Where a "jump to this passage" click should go, given what the DOM currently looks like.
 *
 * Pure so the branch is testable: the guided tour physically relocates hunk and question-card
 * nodes into its own shell, and it hides the full review entirely, so "scroll to the element"
 * has three genuinely different answers depending on where the node currently lives.
 */
export function anchorRevealPlan({ found, inFullReview, fullReviewHidden }) {
  if (!found) return { action: "none" };
  // The node is parked in the hidden full review, so leaving the tour is the only way to show
  // it. Lossless: the tour keeps its position and the top-bar toggle returns to the same step.
  if (inFullReview && fullReviewHidden) return { action: "exit-tour-then-scroll" };
  // Either the tour isn't running, or the tour moved this very node into its own shell, where
  // it is already on screen.
  return { action: "scroll" };
}
