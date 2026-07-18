import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const MULTI_HUNK_DIFF = [
  "diff --git a/a.js b/a.js",
  "index 111..222 100644",
  "--- a/a.js",
  "+++ a/a.js",
  "@@ -1,1 +1,2 @@",
  " context",
  "+added in a",
  "diff --git a/b.js b/b.js",
  "index 333..444 100644",
  "--- a/b.js",
  "+++ a/b.js",
  "@@ -1,1 +1,2 @@",
  " context",
  "+added in b",
  "",
].join("\n");

function extractTour(html) {
  const match = html.match(/<script id="quiz-session" type="application\/json">([\s\S]*?)<\/script>/);
  return JSON.parse(match[1]).tour;
}

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-server-"));
  const stateFile = path.join(dir, "state.json");
  const server = await serve({ port: 0, stateFile, version: "test", idleTimeoutMs: null });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    await fn(baseUrl, stateFile);
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

test("session lifecycle: create, poll (immediate waiting), submit answer, poll delivers it", async () => {
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
  });
});

test("grading the only question correct auto-finishes the review and resolves an in-flight poll as passed", async () => {
  await withServer(async (baseUrl) => {
    const key = "autofinishkey1234";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    await postJson(`${baseUrl}/api/${key}/prompts`, {
      prompts: [
        {
          uid: "",
          prompt: "Answered: Flaky network",
          selector: "",
          tag: "quiz-answer",
          text: "",
          target: { type: "quiz-answer", question_id: "q1", choice_id: "a" },
        },
      ],
    });

    // Drain the queued answer with a bounded poll first, so the long poll started below has
    // nothing queued and genuinely waits (an immediate `takeFeedback` hit would otherwise
    // resolve it right away with the already-queued answer, never reaching the wait branch).
    const drained = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    assert.equal(drained.status, "feedback");

    // Now the long poll genuinely waits - keeping it attached also stops the server's "no live
    // connections" self-shutdown from firing the instant this grade call auto-ends the session.
    const pollPromise = fetch(`${baseUrl}/api/poll?key=${key}`).then((res) => res.json());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const graded = await postJson(`${baseUrl}/api/${key}/grade`, { question_id: "q1", verdict: "correct", feedback: "Exactly right." });
    assert.equal(graded.status, 200);
    assert.equal(graded.body.auto_finished, true);
    assert.deepEqual(graded.body.score, { answered: 1, correct: 1, total: 1 });

    const poll = await pollPromise;
    assert.equal(poll.status, "ended");
    assert.equal(poll.ended_by, "agent");
    assert.equal(poll.outcome, "passed");

    // The session page still renders with the final score after auto-finish.
    const pageRes = await fetch(`${baseUrl}/session/${key}`);
    const html = await pageRes.text();
    assert.equal(pageRes.status, 200);
    assert.match(html, /question-card/);
    assert.match(html, /added line/);
    assert.match(html, /Score: 1\/1/);
  });
});

test("the diff renders as a GitHub-style split view: paired left/right cells with independent line numbers", async () => {
  await withServer(async (baseUrl) => {
    const key = "splitviewkey12345";
    const diffText = [
      "diff --git a/f.js b/f.js",
      "index 111..222 100644",
      "--- a/f.js",
      "+++ b/f.js",
      "@@ -1,2 +1,3 @@",
      " context",
      "-old line",
      "+new line",
      "+extra added line",
      "",
    ].join("\n");
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: diffText, diff_stat: {}, quiz: { version: 1, questions: [] } });

    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /diff-hunk-split/);
    // The unchanged context line appears on both sides.
    assert.equal((html.match(/>context</g) || []).length, 2);
    // The deletion appears only on the left, the two additions only on the right.
    assert.match(html, /split-cell split-left split-del"><span class="split-ln">2<\/span><span class="split-code">old line/);
    assert.match(html, /split-cell split-right split-add"><span class="split-ln">2<\/span><span class="split-code">new line/);
    assert.match(html, /split-cell split-left split-empty/);
    assert.match(html, /split-cell split-right split-add"><span class="split-ln">3<\/span><span class="split-code">extra added line/);
  });
});

test("a trivial (zero-question) quiz can be finished as pass immediately, with no grading at all", async () => {
  await withServer(async (baseUrl, stateFile) => {
    const key = "trivialkey1234567";
    const trivialQuiz = { version: 3, significance: "trivial", diff_summary: "Renamed a variable", questions: [] };
    const created = await postJson(`${baseUrl}/api/sessions`, {
      key,
      repo_root: "/repo",
      diff_text: DIFF_TEXT,
      diff_stat: {},
      quiz: trivialQuiz,
    });
    assert.equal(created.status, 200);

    const finished = await postJson(`${baseUrl}/api/${key}/grade`, { finish: "pass", summary: "trivial: rename" });
    assert.equal(finished.status, 200);
    assert.equal(finished.body.finished, "pass");
    assert.deepEqual(finished.body.score, { answered: 0, correct: 0, total: 0 });

    // The page still renders with zero questions - no crash from an empty questions array.
    const pageRes = await fetch(`${baseUrl}/session/${key}`);
    assert.equal(pageRes.status, 200);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.review_index[key].status, "passed");
    assert.equal(state.review_index[key].passed, true);
  });
});

test("a v1 quiz.json (no explainer, no decisions) renders with no explainer block at all", async () => {
  await withServer(async (baseUrl) => {
    const key = "v1renderkey123456";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.doesNotMatch(html, /class="explainer"/);
    assert.doesNotMatch(html, /Like I'm five/);
    assert.doesNotMatch(html, /decisions-block/);
    // The diff view itself is unaffected by hunk id assignment.
    assert.match(html, /diff-hunk-split" id="hunk-0"/);
  });
});

test("the explainer ladder renders eli5, summary, background, and a walkthrough step linked to its real hunk", async () => {
  await withServer(async (baseUrl) => {
    const key = "laddereeekey123456";
    const quiz = {
      version: 3,
      significance: "small",
      questions: [],
      explainer: {
        eli5: "When you refresh, it now remembers your choice.",
        summary: "Persist the toggle to localStorage.",
        background: "The settings panel already re-renders from a single state object.",
        walkthrough: [{ text: "Added the write to localStorage.", hunk_anchor: { file: "f.js", start_line: 1, end_line: 2 } }],
      },
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /class="explainer"/);
    // eli5 appears before summary, which appears before background, which appears before the walkthrough.
    const eli5At = html.indexOf("When you refresh");
    const summaryAt = html.indexOf("Persist the toggle");
    const backgroundAt = html.indexOf("already re-renders");
    const walkthroughAt = html.indexOf("Added the write to localStorage");
    assert.ok(eli5At > -1 && eli5At < summaryAt && summaryAt < backgroundAt && backgroundAt < walkthroughAt);
    // The walkthrough step's hunk_anchor matched a real hunk, so it links to it by id.
    assert.match(html, /class="walkthrough-step walkthrough-step-linked" data-hunk-target="hunk-0"/);
  });
});

test("a walkthrough step or decision with an unmatched hunk_anchor degrades gracefully - no link, no crash", async () => {
  await withServer(async (baseUrl) => {
    const key = "unmatchedkey123456";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      explainer: {
        summary: "x",
        walkthrough: [{ text: "Refers to a file not in this diff.", hunk_anchor: { file: "nowhere.js", start_line: 1, end_line: 2 } }],
      },
      decisions: [{ id: "d1", who: "human", decision: "Keep it simple", why: "user said so" }],
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const res = await fetch(`${baseUrl}/session/${key}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /class="walkthrough-step">/);
    assert.doesNotMatch(html, /walkthrough-step-linked/);
    assert.match(html, /decision-badge decision-badge-human">Human/);
  });
});

test("decisions render collapsed (details, not open) once there are more than 3", async () => {
  await withServer(async (baseUrl) => {
    const key = "manydecisionskey12";
    const decisions = Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, decision: `Decision ${i}`, why: "" }));
    const quiz = { version: 3, questions: [], significance: "trivial", decisions };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /<details class="decisions-block" id="decisionsBlock"><summary>Decisions \(4\)/);
    assert.doesNotMatch(html, /<details class="decisions-block" id="decisionsBlock" open>/);
  });
});

test("guided tour: the shell renders, defaults to visible with full review hidden, and interleaves a matching question right after its walkthrough step", async () => {
  await withServer(async (baseUrl) => {
    const key = "tourkey123456789ab";
    const quiz = {
      version: 3,
      significance: "small",
      questions: [
        { id: "q1", type: "free-text", prompt: "?", hunk_anchor: { file: "f.js", start_line: 1, end_line: 2 }, anchor_matched: true },
      ],
      explainer: { summary: "x", walkthrough: [{ text: "Added a line.", hunk_anchor: { file: "f.js", start_line: 1, end_line: 2 } }] },
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /id="tourMode"/);
    assert.match(html, /id="tourToggle"/);
    assert.match(html, /id="fullReview" hidden>/, "full review starts hidden - the tour is the default landing view");
    assert.match(
      html,
      /"tour":\[\{"kind":"summary","label":"Summary","text":"x"},\{"kind":"walkthrough","label":"Step 1","text":"Added a line\.","hunk_dom_id":"hunk-0"},\{"kind":"checkpoint","label":"Checkpoint 1","question_id":"q1","hunk_dom_id":"hunk-0","hint_step_index":1},\{"kind":"grade","label":"Grade"}\]/,
    );
  });
});

test("guided tour: no shell at all for a trivial (zero-question, no explainer) quiz - nothing to tour", async () => {
  await withServer(async (baseUrl) => {
    const key = "notrivialtourabcdef";
    const quiz = { version: 3, significance: "trivial", questions: [] };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.doesNotMatch(html, /id="tourMode"/);
    assert.doesNotMatch(html, /id="tourToggle"/);
    assert.match(html, /id="fullReview">/, "no tour means full review renders visible, not hidden");
    assert.match(html, /"tour":\[\]/);
  });
});

test("guided tour: a v1 quiz.json with no explainer still gets a checkpoints-only tour of its unanchored question", async () => {
  await withServer(async (baseUrl) => {
    const key = "unanchoredtourabcde";
    const quiz = { version: 1, questions: [{ id: "q1", type: "free-text", prompt: "?" }] };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(
      html,
      /"tour":\[\{"kind":"checkpoint","label":"Checkpoint 1","question_id":"q1","hunk_dom_id":null},\{"kind":"grade","label":"Grade"}\]/,
    );
  });
});

test("guided tour decisions: <=3 decisions each get their own stop - referenced ones land right before the checkpoint that mentions their id, unreferenced ones after the last walkthrough step", async () => {
  await withServer(async (baseUrl) => {
    const key = "decisionorderkey123";
    const quiz = {
      version: 3,
      questions: [
        { id: "q1", type: "free-text", prompt: "Why d1 over the alternative?", hunk_anchor: { file: "a.js", start_line: 1, end_line: 2 }, anchor_matched: true },
        { id: "q2", type: "free-text", prompt: "What happens now?", hunk_anchor: { file: "b.js", start_line: 1, end_line: 2 }, anchor_matched: true },
      ],
      explainer: {
        summary: "x",
        walkthrough: [
          { text: "Step one.", hunk_anchor: { file: "a.js", start_line: 1, end_line: 2 } },
          { text: "Step two.", hunk_anchor: { file: "b.js", start_line: 1, end_line: 2 } },
        ],
      },
      decisions: [
        { id: "d1", who: "human", decision: "Use approach A", why: "reason", alternatives: ["B"] },
        { id: "d2", who: "agent", decision: "Use approach C" },
      ],
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: MULTI_HUNK_DIFF, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const tour = extractTour(html);
    assert.deepEqual(
      tour.map((step) => step.kind + (step.decision_id ? ":" + step.decision_id : step.question_id ? ":" + step.question_id : "")),
      ["summary", "walkthrough", "decision:d1", "checkpoint:q1", "walkthrough", "decision:d2", "checkpoint:q2", "grade"],
    );
    assert.equal(tour[2].who, "human");
    assert.equal(tour[2].position, 1);
    assert.equal(tour[2].total, 2);
  });
});

test("guided tour decisions: more than 3 decisions render one grouped stop instead of individual ones", async () => {
  await withServer(async (baseUrl) => {
    const key = "decisiongroupkey123";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      decisions: Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, who: i % 2 === 0 ? "agent" : "human", decision: `Decision ${i}` })),
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const tour = extractTour(html);
    const groupStop = tour.find((step) => step.kind === "decisions-group");
    assert.ok(groupStop, "expected a single grouped decisions stop");
    assert.equal(groupStop.label, "Decisions (4)");
    assert.equal(groupStop.decisions.length, 4);
    assert.equal(tour.filter((step) => step.kind === "decision").length, 0, "no individual decision stops once grouped");
  });
});

test("guided tour decisions: a decision with an unmatched hunk_anchor degrades gracefully, same as steps", async () => {
  await withServer(async (baseUrl) => {
    const key = "decisionnomatchkey1";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      decisions: [{ id: "d1", decision: "Something", hunk_anchor: { file: "nowhere.js", start_line: 1, end_line: 2 } }],
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const res = await fetch(`${baseUrl}/session/${key}`);
    assert.equal(res.status, 200);
    const tour = extractTour(await res.text());
    const decisionStop = tour.find((step) => step.kind === "decision");
    assert.equal(decisionStop.hunk_dom_id, null);
  });
});

test("guided tour uncovered hunks: a hunk no walkthrough step anchors to gets its own stop listing exactly that hunk", async () => {
  await withServer(async (baseUrl) => {
    const key = "uncoveredkey1234567";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      explainer: { summary: "x", walkthrough: [{ text: "Only covers a.js.", hunk_anchor: { file: "a.js", start_line: 1, end_line: 2 } }] },
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: MULTI_HUNK_DIFF, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const tour = extractTour(html);
    const uncoveredStop = tour.find((step) => step.kind === "uncovered");
    assert.ok(uncoveredStop, "expected an uncovered-hunks stop");
    assert.equal(uncoveredStop.hunks.length, 1);
    assert.equal(uncoveredStop.hunks[0].file, "b.js");
    assert.equal(uncoveredStop.hunks[0].adds, 1);
    // Right before Grade, and the total step count reflects it (progress denominator includes it).
    assert.equal(tour.at(-1).kind, "grade");
    assert.equal(tour.at(-2).kind, "uncovered");
  });
});

test("guided tour uncovered hunks: a walkthrough that covers every hunk gets no uncovered stop at all", async () => {
  await withServer(async (baseUrl) => {
    const key = "fullycoveredkey1234";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      explainer: {
        summary: "x",
        walkthrough: [
          { text: "Covers a.js.", hunk_anchor: { file: "a.js", start_line: 1, end_line: 2 } },
          { text: "Covers b.js.", hunk_anchor: { file: "b.js", start_line: 1, end_line: 2 } },
        ],
      },
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: MULTI_HUNK_DIFF, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const tour = extractTour(html);
    assert.equal(tour.some((step) => step.kind === "uncovered"), false);
  });
});

test("grading before an answer exists returns 400, not 500", async () => {
  await withServer(async (baseUrl) => {
    const key = "badgradekey123456";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    const badGrade = await postJson(`${baseUrl}/api/${key}/grade`, { question_id: "nonexistent", verdict: "correct" });
    assert.equal(badGrade.status, 400);
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
