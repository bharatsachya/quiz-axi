import assert from "node:assert/strict";
import test from "node:test";

import { collectUngroundedAnchors, validateQuizSpec } from "../src/quiz.js";

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

// The parsed-diff shape both callers hand collectUngroundedAnchors: src/quiz.js touched at
// lines 1-40, src/server.js at 100-120. Nothing else is in this changeset.
const PARSED_DIFF = [
  { file: "src/quiz.js", hunks: [{ startLine: 1, endLine: 40 }] },
  { file: "src/server.js", hunks: [{ startLine: 100, endLine: 120 }] },
];

test("grounding: anchors that overlap a real hunk are grounded, and no anchor is not a failure", () => {
  const spec = {
    explainer: {
      summary: "x",
      walkthrough: [
        { text: "in range", hunk_anchor: { file: "src/quiz.js", start_line: 10, end_line: 20 } },
        { text: "overlaps the hunk edge", hunk_anchor: { file: "src/server.js", start_line: 90, end_line: 101 } },
        { text: "prose with nothing to point at", hunk_anchor: null },
      ],
    },
    questions: [{ id: "q1", type: "free-text", prompt: "Why?", hunk_anchor: null }],
  };
  assert.deepEqual(collectUngroundedAnchors(spec, PARSED_DIFF), []);
});

test("grounding: an anchor naming a file the changeset never touched is reported as file-not-in-diff", () => {
  const spec = {
    explainer: {
      summary: "x",
      walkthrough: [{ text: "explains work that isn't here", hunk_anchor: { file: "src/nope.js", start_line: 1, end_line: 5 } }],
    },
    questions: [],
  };
  const ungrounded = collectUngroundedAnchors(spec, PARSED_DIFF);
  assert.equal(ungrounded.length, 1);
  assert.equal(ungrounded[0].reason, "file-not-in-diff");
  assert.equal(ungrounded[0].where, "explainer.walkthrough[0]");
  assert.equal(ungrounded[0].file, "src/nope.js");
  assert.equal(ungrounded[0].label, "explains work that isn't here");
});

test("grounding: a real file whose line range matches no hunk is reported as no-matching-hunk", () => {
  const spec = {
    explainer: { summary: "x", walkthrough: [{ text: "stale lines", hunk_anchor: { file: "src/quiz.js", start_line: 500, end_line: 510 } }] },
    questions: [],
  };
  const ungrounded = collectUngroundedAnchors(spec, PARSED_DIFF);
  assert.equal(ungrounded.length, 1);
  assert.equal(ungrounded[0].reason, "no-matching-hunk");
});

test("grounding: decisions and questions are checked too, not just the walkthrough", () => {
  const spec = {
    explainer: { summary: "x", walkthrough: [] },
    decisions: [{ id: "d1", who: "agent", decision: "chose X", why: "", hunk_anchor: { file: "gone.js", start_line: 1, end_line: 2 } }],
    questions: [{ id: "q1", type: "free-text", prompt: "Why?", hunk_anchor: { file: "src/quiz.js", start_line: 900, end_line: 901 } }],
  };
  const ungrounded = collectUngroundedAnchors(spec, PARSED_DIFF);
  assert.deepEqual(
    ungrounded.map((entry) => [entry.where, entry.reason]),
    [
      ['decisions["d1"]', "file-not-in-diff"],
      ['questions["q1"]', "no-matching-hunk"],
    ],
  );
});

test("grounding: a v1 spec with no explainer and no decisions is checked without throwing", () => {
  const spec = { questions: [{ id: "q1", type: "free-text", prompt: "Why?", hunk_anchor: { file: "src/quiz.js", start_line: 5, end_line: 6 } }] };
  assert.deepEqual(collectUngroundedAnchors(spec, PARSED_DIFF), []);
});
