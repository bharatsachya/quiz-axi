import assert from "node:assert/strict";
import test from "node:test";

import { validateQuizSpec } from "../src/quiz.js";

const ONE_QUESTION = [{ id: "q1", type: "free-text", prompt: "Why?" }];

test("v1: a plain questions-only spec is accepted and defaults version to 1", () => {
  const spec = validateQuizSpec({ diff_summary: "x", questions: ONE_QUESTION });
  assert.equal(spec.version, 1);
  assert.equal(spec.diff_summary, "x");
  assert.equal(spec.questions.length, 1);
  assert.equal(spec.explainer, undefined);
  assert.equal(spec.decisions, undefined);
  assert.deepEqual(spec.warnings, []);
});

test("v1: explicit version 1 with no new fields validates exactly as before", () => {
  const spec = validateQuizSpec({ version: 1, questions: ONE_QUESTION });
  assert.equal(spec.version, 1);
  assert.deepEqual(spec.warnings, []);
});

test("v1: missing questions array is rejected", () => {
  assert.throws(() => validateQuizSpec({}), /must include a `questions` array/);
});

test("v1: empty questions array is rejected when there is no significance", () => {
  assert.throws(() => validateQuizSpec({ questions: [] }), /cannot be empty unless significance is "trivial"/);
});

test("v1: not an object is rejected", () => {
  assert.throws(() => validateQuizSpec(null), /must be a JSON object/);
  assert.throws(() => validateQuizSpec([]), /must be a JSON object/);
});

test("v1: duplicate question ids are rejected", () => {
  assert.throws(
    () => validateQuizSpec({ questions: [ONE_QUESTION[0], { ...ONE_QUESTION[0] }] }),
    /Duplicate question id "q1"/,
  );
});

test("v1: multiple-choice needs at least 2 choices", () => {
  assert.throws(
    () =>
      validateQuizSpec({
        questions: [{ id: "q1", type: "multiple-choice", prompt: "?", choices: [{ id: "a", text: "A" }] }],
      }),
    /needs at least 2 `choices`/,
  );
});

test("v1: an invalid hunk_anchor is rejected with a question-scoped message", () => {
  assert.throws(
    () =>
      validateQuizSpec({
        questions: [{ id: "q1", type: "free-text", prompt: "?", hunk_anchor: { file: "f.js", start_line: 5, end_line: 2 } }],
      }),
    /questions\[0\] \("q1"\) has an invalid hunk_anchor/,
  );
});

test('v2/v3: significance "trivial" with an empty questions array is accepted', () => {
  const spec = validateQuizSpec({ version: 3, significance: "trivial", questions: [] });
  assert.equal(spec.significance, "trivial");
  assert.deepEqual(spec.questions, []);
});

test("v2/v3: an unknown significance value warns and is dropped, empty questions still rejected", () => {
  assert.throws(() => validateQuizSpec({ significance: "urgent", questions: [] }), /cannot be empty/);
  const spec = validateQuizSpec({ significance: "urgent", questions: ONE_QUESTION });
  assert.equal(spec.significance, undefined);
  assert.match(spec.warnings.join(" "), /Unknown significance "urgent" ignored/);
});

test("v2/v3: full explainer (eli5, summary, background, walkthrough) round-trips", () => {
  const spec = validateQuizSpec({
    version: 3,
    significance: "normal",
    explainer: {
      eli5: "Like a light switch.",
      summary: "Adds a toggle.",
      background: "There is a settings panel.",
      walkthrough: [{ text: "Added the toggle.", hunk_anchor: { file: "src/a.js", start_line: 1, end_line: 3 } }],
    },
    questions: ONE_QUESTION,
  });
  assert.equal(spec.explainer.eli5, "Like a light switch.");
  assert.equal(spec.explainer.summary, "Adds a toggle.");
  assert.equal(spec.explainer.background, "There is a settings panel.");
  assert.equal(spec.explainer.walkthrough.length, 1);
  assert.deepEqual(spec.explainer.walkthrough[0].hunk_anchor, { file: "src/a.js", start_line: 1, end_line: 3 });
});

test("v2/v3: explainer omitting eli5/background leaves them undefined, not empty strings", () => {
  const spec = validateQuizSpec({ explainer: { summary: "x" }, questions: ONE_QUESTION });
  assert.equal(spec.explainer.eli5, undefined);
  assert.equal(spec.explainer.background, undefined);
  assert.deepEqual(spec.explainer.walkthrough, []);
});

test("v2/v3: explainer must be an object if present", () => {
  assert.throws(() => validateQuizSpec({ explainer: "nope", questions: ONE_QUESTION }), /`explainer` must be an object/);
});

test("v2/v3: a walkthrough step needs non-empty text", () => {
  assert.throws(
    () => validateQuizSpec({ explainer: { walkthrough: [{ text: "" }] }, questions: ONE_QUESTION }),
    /walkthrough\[0\] is missing a non-empty `text`/,
  );
});

test("v2/v3: decisions accepts who agent/human, alternatives, and hunk_anchor", () => {
  const spec = validateQuizSpec({
    decisions: [
      { id: "d1", who: "human", decision: "Use Bun", alternatives: ["npm", "pnpm"], why: "user preference" },
      { id: "d2", decision: "Content-address sessions", why: "stable across rebase" },
    ],
    questions: ONE_QUESTION,
  });
  assert.equal(spec.decisions.length, 2);
  assert.equal(spec.decisions[0].who, "human");
  assert.deepEqual(spec.decisions[0].alternatives, ["npm", "pnpm"]);
  assert.equal(spec.decisions[1].who, "agent", "who defaults to agent when omitted");
});

test("v2/v3: an unknown decision `who` warns and defaults to agent instead of rejecting", () => {
  const spec = validateQuizSpec({
    decisions: [{ id: "d1", who: "robot", decision: "x", why: "y" }],
    questions: ONE_QUESTION,
  });
  assert.equal(spec.decisions[0].who, "agent");
  assert.match(spec.warnings.join(" "), /unknown `who` "robot", defaulting to "agent"/);
});

test("v2/v3: a decision needs a non-empty id and decision text", () => {
  assert.throws(() => validateQuizSpec({ decisions: [{ decision: "x" }], questions: ONE_QUESTION }), /missing a non-empty `id`/);
  assert.throws(
    () => validateQuizSpec({ decisions: [{ id: "d1" }], questions: ONE_QUESTION }),
    /missing a non-empty `decision`/,
  );
});

test("v2/v3: duplicate decision ids are rejected", () => {
  assert.throws(
    () =>
      validateQuizSpec({
        decisions: [
          { id: "d1", decision: "a", why: "" },
          { id: "d1", decision: "b", why: "" },
        ],
        questions: ONE_QUESTION,
      }),
    /Duplicate decision id "d1"/,
  );
});

test("forward compat: unknown top-level and nested fields warn, never reject", () => {
  const spec = validateQuizSpec({
    made_up_field: true,
    explainer: { summary: "x", extra_field: 1 },
    questions: ONE_QUESTION,
  });
  assert.match(spec.warnings.join(" "), /Unknown quiz\.json field "made_up_field" ignored/);
  assert.match(spec.warnings.join(" "), /Unknown explainer field "extra_field" ignored/);
});

test("forward compat: an unrecognized version number still parses fields, with a warning", () => {
  const spec = validateQuizSpec({ version: 7, explainer: { summary: "x" }, questions: ONE_QUESTION });
  assert.equal(spec.version, 7);
  assert.equal(spec.explainer.summary, "x");
  assert.match(spec.warnings.join(" "), /Unknown quiz\.json version 7/);
});
