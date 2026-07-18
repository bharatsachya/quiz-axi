import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createPollOutput, createReviewOutput, verifyOneDiff } from "../src/cli.js";
import { SessionStore } from "../src/session-store.js";

test("createReviewOutput tells the agent to poll next, not respond to the user", () => {
  const output = createReviewOutput({ diffKey: "abc123", url: "http://localhost:4388/session/abc123", status: "opened" });
  assert.deepEqual(output.review, { diff_key: "abc123", url: "http://localhost:4388/session/abc123", status: "opened" });
  assert.match(output.next_step, /Do not respond to the user just yet/);
  assert.match(output.next_step, /quiz-axi poll abc123/);
});

test("createPollOutput throws NOT_FOUND for a missing session", () => {
  assert.throws(() => createPollOutput({ diffKey: "abc", response: { status: "missing" } }), /No active quiz-axi review session/);
});

test("createPollOutput branches on quiz-answer vs message prompts", () => {
  const answerOnly = createPollOutput({
    diffKey: "abc",
    response: {
      status: "feedback",
      score: { answered: 1, correct: 0, total: 2 },
      prompts: [{ uid: "", prompt: "Answered: A", selector: "", tag: "quiz-answer", text: "", target: { type: "quiz-answer", question_id: "q1", choice_id: "a" } }],
    },
  });
  assert.match(answerOnly.next_step, /Grade each with `quiz-axi grade abc --question/);
  assert.doesNotMatch(answerOnly.next_step, /Reply with/);

  const questionOnly = createPollOutput({
    diffKey: "abc",
    response: { status: "feedback", score: { answered: 0, correct: 0, total: 2 }, prompts: [{ uid: "", prompt: "why?", selector: "", tag: "message", text: "" }] },
  });
  assert.match(questionOnly.next_step, /Reply with `quiz-axi poll abc --agent-reply/);
  assert.doesNotMatch(questionOnly.next_step, /Grade each with/);
});

test("createPollOutput ended response tells the agent to stop polling and finish grading if needed", () => {
  const output = createPollOutput({ diffKey: "abc", response: { status: "ended", ended_by: "user" } });
  assert.equal(output.session.status, "ended");
  assert.match(output.next_step, /Stop polling abc/);
  assert.match(output.next_step, /quiz-axi grade abc --finish pass\|fail/);
});

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-verify-"));
  try {
    const store = new SessionStore(path.join(dir, "state.json"));
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("verifyOneDiff: no record blocks with guidance to run review", async () => {
  await withStore(async (store) => {
    const result = await verifyOneDiff(store, "missing-key", "main");
    assert.equal(result.ok, false);
    assert.match(result.message, /no quiz review found/);
    assert.match(result.message, /quiz-axi review --quiz/);
  });
});

test("verifyOneDiff: pending (never finished) blocks with guidance to finish grading", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: { questions: [] } });
    const result = await verifyOneDiff(store, "key1", "main");
    assert.equal(result.ok, false);
    assert.match(result.message, /never finished/);
  });
});

test("verifyOneDiff: failed review blocks", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: { questions: [] } });
    await store.finishGrading("key1", { result: "fail", summary: "" });
    const result = await verifyOneDiff(store, "key1", "main");
    assert.equal(result.ok, false);
    assert.match(result.message, /marked FAILED/);
  });
});

test("verifyOneDiff: passed review allows", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: { questions: [] } });
    await store.finishGrading("key1", { result: "pass", summary: "" });
    const result = await verifyOneDiff(store, "key1", "main");
    assert.equal(result.ok, true);
  });
});
