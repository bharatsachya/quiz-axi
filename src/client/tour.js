// The guided tour's gate and rail glyphs - the only client logic that ENFORCES something, so
// the only client logic worth unit-testing more than anything else here. Extracted verbatim
// from chrome-client.js; the module-level mutables it used to close over (tourIndex, the
// verdict map, the visited set) are now passed in, which is the whole reason it is testable.
//
// Browser-side ES module, also imported by node:test. No DOM access in this file.

export const TOUR_MUST_VISIT_KINDS = new Set(["decision", "decisions-group", "uncovered"]);

// Reading is never gated - you can always look back at anything, and the raw-diff escape
// hatch docked at the bottom of the rail is always open. Only ADVANCING is gated: the first
// unresolved checkpoint (not yet graded correct) or not-yet-visited decision/uncovered stop is
// a hard wall nothing past it is reachable, computed fresh every time (never cached) so a
// grade arriving mid-browse immediately opens the path forward.
export function maxReachableTourIndex(steps, { verdicts = {}, visited = new Set() } = {}) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.kind === "checkpoint" && verdicts[step.question_id] !== "correct") return index;
    if (TOUR_MUST_VISIT_KINDS.has(step.kind) && !visited.has(index)) return index;
  }
  return steps.length - 1;
}

export function tourRailIcon(step, index, { maxReachable, currentIndex, verdicts = {} }) {
  if (index > maxReachable) return "🔒";
  if (step.kind === "checkpoint") {
    const verdict = verdicts[step.question_id];
    if (verdict === "correct") return "✓";
    if (verdict === "incorrect") return "✕";
    return "◇";
  }
  if (step.kind === "uncovered") return "▨";
  if (TOUR_MUST_VISIT_KINDS.has(step.kind)) return "◈";
  if (index === currentIndex) return "▸";
  if (index < currentIndex) return "✓";
  return step.kind === "grade" ? "⚑" : "";
}

export function tourRailKindClass(step) {
  return TOUR_MUST_VISIT_KINDS.has(step.kind) ? " tour-rail-decision" : "";
}
