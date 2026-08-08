// Characterization tests for the guided tour's gate. This logic lived untested inside
// chrome-client.js; these assertions describe what it did there, so the extraction can be
// checked rather than trusted. The rule being pinned down: reading is never blocked, only
// advancing.

import assert from "node:assert/strict";
import test from "node:test";

import { TOUR_MUST_VISIT_KINDS, maxReachableTourIndex, tourRailIcon, tourRailKindClass } from "../src/client/tour.js";

const summary = { kind: "summary", label: "Summary" };
const step1 = { kind: "walkthrough", label: "Step 1" };
const step2 = { kind: "walkthrough", label: "Step 2" };
const checkpoint = (id) => ({ kind: "checkpoint", question_id: id, label: `Question ${id}` });
const decision = (id) => ({ kind: "decision", decision_id: id, label: `Decision ${id}` });
const grade = { kind: "grade", label: "Grade" };

test("gate: with nothing to resolve, every step is reachable", () => {
  const steps = [summary, step1, step2, grade];
  assert.equal(maxReachableTourIndex(steps), steps.length - 1);
});

test("gate: an ungraded checkpoint is a hard wall at its own index", () => {
  const steps = [summary, step1, checkpoint("q1"), step2, grade];
  assert.equal(maxReachableTourIndex(steps, { verdicts: {}, visited: new Set() }), 2);
});

test("gate: only a `correct` verdict opens the wall - `incorrect` still blocks", () => {
  const steps = [summary, checkpoint("q1"), step1, grade];
  assert.equal(maxReachableTourIndex(steps, { verdicts: { q1: "incorrect" } }), 1);
  assert.equal(maxReachableTourIndex(steps, { verdicts: { q1: null } }), 1);
  assert.equal(maxReachableTourIndex(steps, { verdicts: { q1: "correct" } }), steps.length - 1);
});

test("gate: the wall moves to the NEXT unresolved checkpoint once the first is passed", () => {
  const steps = [checkpoint("q1"), step1, checkpoint("q2"), step2, grade];
  assert.equal(maxReachableTourIndex(steps, { verdicts: { q1: "correct" } }), 2);
  assert.equal(maxReachableTourIndex(steps, { verdicts: { q1: "correct", q2: "correct" } }), steps.length - 1);
});

test("gate: a must-visit stop blocks until visited, and visiting is by INDEX not by id", () => {
  const steps = [summary, decision("d1"), step1, grade];
  assert.equal(maxReachableTourIndex(steps, { visited: new Set() }), 1);
  assert.equal(maxReachableTourIndex(steps, { visited: new Set([0]) }), 1);
  assert.equal(maxReachableTourIndex(steps, { visited: new Set([1]) }), steps.length - 1);
});

test("gate: every must-visit kind gates, and a plain walkthrough step never does", () => {
  for (const kind of ["decision", "decisions-group", "uncovered"]) {
    assert.equal(maxReachableTourIndex([summary, { kind }, grade], { visited: new Set() }), 1, `${kind} should gate`);
  }
  assert.equal(maxReachableTourIndex([summary, step1, grade], { visited: new Set() }), 2);
});

test("gate: the earliest wall wins when a checkpoint and a must-visit stop are both unresolved", () => {
  const steps = [decision("d1"), checkpoint("q1"), grade];
  assert.equal(maxReachableTourIndex(steps, { verdicts: {}, visited: new Set() }), 0);
  assert.equal(maxReachableTourIndex(steps, { verdicts: {}, visited: new Set([0]) }), 1);
});

// -1 rather than 0: an empty tour has no reachable step at all, and showTourStep clamps
// against this value. Pinned down because it is the kind of edge an extraction quietly changes.
test("gate: an empty step list reports -1, not 0", () => {
  assert.equal(maxReachableTourIndex([]), -1);
});

test("gate: omitting verdicts/visited entirely behaves as if both were empty", () => {
  const steps = [checkpoint("q1"), grade];
  assert.equal(maxReachableTourIndex(steps), 0);
});

test("rail icon: a locked step reads as locked whatever its kind", () => {
  assert.equal(tourRailIcon(step1, 5, { maxReachable: 2, currentIndex: 0, verdicts: {} }), "🔒");
  assert.equal(tourRailIcon(checkpoint("q1"), 5, { maxReachable: 2, currentIndex: 0, verdicts: {} }), "🔒");
});

test("rail icon: a checkpoint shows its verdict", () => {
  const at = (verdicts) => tourRailIcon(checkpoint("q1"), 1, { maxReachable: 3, currentIndex: 0, verdicts });
  assert.equal(at({ q1: "correct" }), "✓");
  assert.equal(at({ q1: "incorrect" }), "✕");
  assert.equal(at({}), "◇");
});

test("rail icon: position glyphs apply only to steps that aren't checkpoints or must-visits", () => {
  const state = { maxReachable: 9, currentIndex: 3, verdicts: {} };
  assert.equal(tourRailIcon(step1, 3, state), "▸");
  assert.equal(tourRailIcon(step1, 1, state), "✓");
  assert.equal(tourRailIcon(step1, 5, state), "");
  assert.equal(tourRailIcon(grade, 5, state), "⚑");
  assert.equal(tourRailIcon(decision("d1"), 5, state), "◈");
  assert.equal(tourRailIcon({ kind: "uncovered" }, 5, state), "▨");
});

test("rail kind class: only must-visit stops get the decision class", () => {
  assert.equal(tourRailKindClass(decision("d1")), " tour-rail-decision");
  assert.equal(tourRailKindClass({ kind: "uncovered" }), " tour-rail-decision");
  assert.equal(tourRailKindClass(step1), "");
  assert.equal(tourRailKindClass(checkpoint("q1")), "");
});

test("the must-visit set is exactly decision, decisions-group and uncovered", () => {
  assert.deepEqual([...TOUR_MUST_VISIT_KINDS].sort(), ["decision", "decisions-group", "uncovered"]);
});
