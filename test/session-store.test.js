import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

const QUIZ = {
  version: 1,
  diff_summary: "",
  questions: [
    { id: "q1", type: "multiple-choice", prompt: "Why?", choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }], hunk_anchor: null, anchor_matched: false },
    { id: "q2", type: "free-text", prompt: "Explain", hunk_anchor: null, anchor_matched: false },
  ],
};

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-store-"));
  try {
    const store = new SessionStore(path.join(dir, "state.json"));
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("upsertSession creates a session and a pending review_index entry", async () => {
  await withStore(async (store) => {
    const session = await store.upsertSession("key1", {
      repoRoot: "/repo",
      url: "http://localhost:4388/session/key1",
      diffText: "diff --git a/f b/f\n",
      diffStat: { files_changed: 1, insertions: 1, deletions: 0 },
      quiz: QUIZ,
    });
    assert.equal(session.status, "open");
    assert.deepEqual(session.score, { answered: 0, correct: 0, total: 2 });

    const record = await store.findReviewIndex("key1");
    assert.equal(record.status, "pending");
    assert.equal(record.passed, null);
  });
});

test("quiz-answer prompts are mirrored into session.answers and delivered via takeFeedback", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: QUIZ });
    await store.queuePrompts("key1", {
      prompts: [
        {
          uid: "",
          prompt: "Answered: A",
          selector: "",
          tag: "quiz-answer",
          text: "Quiz answer",
          target: { type: "quiz-answer", question_id: "q1", choice_id: "a" },
        },
      ],
    });

    const session = await store.findByKey("key1");
    assert.equal(session.answers.q1.value, "a");
    assert.equal(session.answers.q1.verdict, null);
    assert.deepEqual(session.score, { answered: 1, correct: 0, total: 2 });

    const delivered = await store.takeFeedback("key1");
    assert.equal(delivered.status, "feedback");
    assert.equal(delivered.prompts.length, 1);
    assert.equal(delivered.prompts[0].target.question_id, "q1");

    const again = await store.takeFeedback("key1");
    assert.equal(again.status, "waiting");
  });
});

test("gradeQuestion requires an existing answer, records verdict, updates score and review_index", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: QUIZ });

    await assert.rejects(() => store.gradeQuestion("key1", { questionId: "q1", verdict: "correct" }), /No answer recorded/);

    await store.queuePrompts("key1", {
      prompts: [
        { uid: "", prompt: "Answered: A", selector: "", tag: "quiz-answer", text: "", target: { type: "quiz-answer", question_id: "q1", choice_id: "a" } },
      ],
    });

    const graded = await store.gradeQuestion("key1", { questionId: "q1", verdict: "correct", feedback: "Nice work" });
    assert.equal(graded.answers.q1.verdict, "correct");
    assert.deepEqual(graded.score, { answered: 1, correct: 1, total: 2 });
    assert.equal(graded.chat.at(-1).role, "agent");
    assert.equal(graded.chat.at(-1).text, "Nice work");

    const record = await store.findReviewIndex("key1");
    assert.deepEqual(record.score, { answered: 1, correct: 1, total: 2 });
    assert.equal(record.status, "pending");
  });
});

test("finishGrading seals review_index as passed or failed", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: QUIZ });

    await store.finishGrading("key1", { result: "fail", summary: "Not quite" });
    let record = await store.findReviewIndex("key1");
    assert.equal(record.status, "failed");
    assert.equal(record.passed, false);
    assert.ok(record.finished_at);

    await store.finishGrading("key1", { result: "pass", summary: "Now correct" });
    record = await store.findReviewIndex("key1");
    assert.equal(record.status, "passed");
    assert.equal(record.passed, true);
  });
});

test("endSession sets status and ended_by", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: QUIZ });
    const ended = await store.endSession("key1", "user");
    assert.equal(ended.status, "ended");
    assert.equal(ended.ended_by, "user");

    const afterEnd = await store.takeFeedback("key1");
    assert.equal(afterEnd.status, "ended");
    assert.equal(afterEnd.ended_by, "user");
  });
});

test("prompts queued before an end are still delivered before the ended status", async () => {
  await withStore(async (store) => {
    await store.upsertSession("key1", { repoRoot: "/repo", url: "u", diffText: "d", diffStat: {}, quiz: QUIZ });
    await store.queuePrompts("key1", {
      prompts: [{ uid: "", prompt: "hi", selector: "", tag: "message", text: "" }],
      endSession: true,
    });
    const session = await store.findByKey("key1");
    assert.equal(session.status, "ended");
    assert.equal(session.ended_by, "user");

    const delivered = await store.takeFeedback("key1");
    assert.equal(delivered.status, "feedback");
    assert.equal(delivered.session_ended, true);
    assert.equal(delivered.ended_by, "user");

    const after = await store.takeFeedback("key1");
    assert.equal(after.status, "ended");
  });
});
