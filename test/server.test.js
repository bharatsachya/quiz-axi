import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";

const QUIZ = {
  version: 1,
  diff_summary: "Bumped retry count",
  questions: [
    {
      id: "q1",
      type: "multiple-choice",
      prompt: "Why did retries change?",
      choices: [
        { id: "a", text: "Flaky network" },
        { id: "b", text: "No reason" },
      ],
      hunk_anchor: { file: "f.js", start_line: 1, end_line: 2 },
      anchor_matched: true,
    },
  ],
};

const DIFF_TEXT = ["diff --git a/f.js b/f.js", "index 111..222 100644", "--- a/f.js", "+++ b/f.js", "@@ -1,1 +1,2 @@", " context", "+added line", ""].join(
  "\n",
);

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-server-"));
  const stateFile = path.join(dir, "state.json");
  const server = await serve({ port: 0, stateFile, version: "test", idleTimeoutMs: null });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("health check reports the app name and version", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.app, "quiz-axi");
    assert.equal(body.version, "test");
  });
});

test("session lifecycle: create, poll (immediate waiting), submit answer, poll delivers it, grade, finish", async () => {
  await withServer(async (baseUrl) => {
    const key = "testkey1234567890";
    const created = await postJson(`${baseUrl}/api/sessions`, {
      key,
      repo_root: "/repo",
      diff_text: DIFF_TEXT,
      diff_stat: { files_changed: 1, insertions: 1, deletions: 0 },
      quiz: QUIZ,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.status, "opened");
    assert.match(created.body.url, new RegExp(`/session/${key}$`));

    // Immediate poll with nothing queued should report "waiting" (short timeout to avoid a real long-poll in tests).
    const waitingRes = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`);
    const waiting = await waitingRes.json();
    assert.equal(waiting.status, "waiting");

    // Submit an answer.
    const submitted = await postJson(`${baseUrl}/api/${key}/prompts`, {
      prompts: [
        {
          uid: "",
          prompt: "Answered: Flaky network",
          selector: "",
          tag: "quiz-answer",
          text: "Quiz answer",
          target: { type: "quiz-answer", question_id: "q1", choice_id: "a" },
        },
      ],
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.score.answered, 1);

    // Poll should now deliver it immediately.
    const feedbackRes = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`);
    const feedback = await feedbackRes.json();
    assert.equal(feedback.status, "feedback");
    assert.equal(feedback.prompts.length, 1);
    assert.equal(feedback.prompts[0].target.question_id, "q1");

    // Grade it.
    const graded = await postJson(`${baseUrl}/api/${key}/grade`, { question_id: "q1", verdict: "correct", feedback: "Exactly right." });
    assert.equal(graded.status, 200);
    assert.deepEqual(graded.body.score, { answered: 1, correct: 1, total: 1 });

    // Grading before an answer exists should 400, not 500.
    const badGrade = await postJson(`${baseUrl}/api/${key}/grade`, { question_id: "nonexistent", verdict: "correct" });
    assert.equal(badGrade.status, 400);

    // Finish the review.
    const finished = await postJson(`${baseUrl}/api/${key}/grade`, { finish: "pass", summary: "All good." });
    assert.equal(finished.status, 200);
    assert.equal(finished.body.finished, "pass");

    // The session page renders the diff and the question card.
    const pageRes = await fetch(`${baseUrl}/session/${key}`);
    const html = await pageRes.text();
    assert.equal(pageRes.status, 200);
    assert.match(html, /question-card/);
    assert.match(html, /added line/);
    assert.match(html, /Score: 1\/1/);
  });
});

test("ending a session as the agent resolves an in-flight poll with status ended", async () => {
  await withServer(async (baseUrl) => {
    const key = "endtestkey1234567";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });

    // Start a long poll (no timeoutMs) before ending, mirroring the real agent flow where the
    // poll is already attached when the human/agent ends the session - this also keeps the
    // server's "no live connections" self-shutdown from firing mid-test.
    const pollPromise = fetch(`${baseUrl}/api/poll?key=${key}`).then((res) => res.json());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ended = await postJson(`${baseUrl}/api/end`, { key });
    assert.equal(ended.body.status, "ended");

    const poll = await pollPromise;
    assert.equal(poll.status, "ended");
    assert.equal(poll.ended_by, "agent");
  });
});
