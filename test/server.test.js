import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readdir } from "node:fs/promises";

import { CLIENT_MODULES, STATIC_ASSETS, serve } from "../src/server.js";

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
    assert.match(html, /split-cell split-left split-del" data-side="old" data-ln="2"><span class="split-ln">2<\/span><span class="split-code">old line/);
    assert.match(html, /split-cell split-right split-add" data-side="new" data-ln="2"><span class="split-ln">2<\/span><span class="split-code">new line/);
    assert.match(html, /split-cell split-left split-empty/);
    assert.match(html, /split-cell split-right split-add" data-side="new" data-ln="3"><span class="split-ln">3<\/span><span class="split-code">extra added line/);
    // A padding cell has no line to anchor to, so it carries no anchor attributes at all.
    assert.match(html, /split-cell split-left split-empty"><\/div>/);
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
    assert.match(html, /diff-hunk-details" id="hunk-0"/);
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

test("grounding notice: claims anchored to a file outside the diff are counted and named on the page", async () => {
  await withServer(async (baseUrl) => {
    const key = "groundingnoticekey1";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      explainer: {
        summary: "x",
        walkthrough: [
          { text: "grounded step", hunk_anchor: { file: "f.js", start_line: 1, end_line: 2 } },
          { text: "step about work that is not here", hunk_anchor: { file: "ghost.js", start_line: 1, end_line: 2 } },
        ],
      },
      decisions: [{ id: "d1", decision: "stale anchor", hunk_anchor: { file: "f.js", start_line: 900, end_line: 901 } }],
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /2 claims here point at code that isn't in this diff/);
    assert.match(html, /ghost\.js<\/code> - not in this diff at all/);
    assert.match(html, /lines 900-901 match no hunk/);
    assert.match(html, /step about work that is not here/);
  });
});

test("grounding notice: absent entirely when every supplied anchor matches a real hunk", async () => {
  await withServer(async (baseUrl) => {
    const key = "groundingcleankey12";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      explainer: {
        summary: "x",
        walkthrough: [
          { text: "grounded", hunk_anchor: { file: "f.js", start_line: 1, end_line: 2 } },
          { text: "unanchored prose is not a grounding failure", hunk_anchor: null },
        ],
      },
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.equal(html.includes("grounding-notice"), false);
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

// The client is loaded as <script type="module">, and a module graph ABORTS on a failed
// import - one 404 leaves a blank page rather than the "no JS, still readable" degradation a
// classic script gave. So every relative specifier the client actually imports has to resolve
// to a served route. This test is the only thing standing between a forgotten STATIC_ASSETS
// entry and a page that renders nothing.
async function clientImportSpecifiers() {
  const roots = ["../src/chrome-client.js"];
  for (const name of CLIENT_MODULES) roots.push(`../src/client/${name}`);
  const found = new Set();
  for (const rel of roots) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    for (const match of source.matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)) {
      // "./client/tour.js" from chrome-client.js -> "/client/tour.js"; a sibling import from
      // inside src/client/ resolves the same way.
      found.add(new URL(match[1], new URL(rel, import.meta.url)).pathname.replace(/^.*\/src\//, "/").replace("/client/", "/client/"));
    }
  }
  return [...found];
}

test("served modules: every relative import in the client resolves to a served route", async () => {
  const specifiers = await clientImportSpecifiers();
  assert.ok(specifiers.length > 0, "expected the client to import at least one module");
  await withServer(async (baseUrl) => {
    for (const route of specifiers) {
      assert.ok(STATIC_ASSETS.has(route), `${route} is imported by the client but missing from STATIC_ASSETS`);
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} did not serve`);
      assert.match(res.headers.get("content-type") || "", /javascript/, `${route} served a non-JS content type`);
    }
  });
});

// The reverse direction: a module added to src/client/ but never listed is not served, so the
// first import of it would blank the page at runtime instead of failing here.
test("served modules: every file in src/client/ is listed in CLIENT_MODULES", async () => {
  const onDisk = (await readdir(new URL("../src/client", import.meta.url))).filter((name) => name.endsWith(".js"));
  assert.deepEqual(onDisk.sort(), [...CLIENT_MODULES].sort());
});

test("served modules: the page loads the client as a module, not a classic script", async () => {
  await withServer(async (baseUrl) => {
    const key = "modulescripttagkey1";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /<script type="module" src="\/chrome-client\.js"><\/script>/);
  });
});

test("served modules: an unlisted path under /client/ is not served", async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/client/nope.js`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/client/../session-store.js`)).status, 404);
  });
});

test("theme: the bootstrap runs in <head> BEFORE the stylesheet, or dark readers get a white flash", async () => {
  await withServer(async (baseUrl) => {
    const key = "themebootstrapkey1";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const bootstrapAt = html.indexOf("localStorage.getItem");
    const stylesheetAt = html.indexOf('<link rel="stylesheet"');
    const headEndsAt = html.indexOf("</head>");
    assert.ok(bootstrapAt > 0, "expected an inline theme bootstrap");
    assert.ok(bootstrapAt < stylesheetAt, "bootstrap must precede the stylesheet");
    assert.ok(bootstrapAt < headEndsAt, "bootstrap must be inside <head>");
    // Synchronous: defer/async would run it after the first paint, defeating the whole point.
    assert.doesNotMatch(html.slice(bootstrapAt - 60, bootstrapAt), /<script[^>]*\b(defer|async)\b/);
  });
});

// The hazard this guards is a real one in the project this was ported from: the storage key
// lived as two separate string literals, free to drift, and the symptom was a theme choice
// that survived a reload only sometimes.
test("theme: the bootstrap and the client are handed the same storage key", async () => {
  await withServer(async (baseUrl) => {
    const key = "themestoragekey123";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const inBootstrap = html.match(/localStorage\.getItem\("([^"]+)"\)/);
    const session = JSON.parse(html.match(/<script id="quiz-session" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.ok(inBootstrap, "expected the bootstrap to read a storage key");
    assert.equal(inBootstrap[1], session.themeStorageKey);
  });
});

test("theme: the bootstrap only honours the two known values, never arbitrary stored text", async () => {
  await withServer(async (baseUrl) => {
    const key = "themevalidationkey";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /t==="dark"\|\|t==="light"/);
  });
});

test("theme: the toggle renders even for a trivial review with no guided tour", async () => {
  await withServer(async (baseUrl) => {
    const key = "themetrivialkey123";
    await postJson(`${baseUrl}/api/sessions`, {
      key,
      repo_root: "/repo",
      diff_text: DIFF_TEXT,
      diff_stat: {},
      quiz: { version: 3, significance: "trivial", questions: [] },
    });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /data-theme-toggle/);
    assert.doesNotMatch(html, /id="tourToggle"/);
  });
});

const ANCHOR_QUIZ = {
  version: 3,
  significance: "normal",
  explainer: {
    eli5: "Plain words about the change.",
    summary: "What changed and why.",
    walkthrough: [{ text: "The first step of the change." }, { text: "The second step of the change." }],
  },
  decisions: [{ id: "d1", who: "agent", decision: "Chose X over Y", why: "Because of Z", alternatives: ["Y"] }],
  questions: [{ id: "q1", type: "free-text", prompt: "Why X?" }],
};

test("anchor blocks: every prose block the reader can highlight gets a stable id", async () => {
  await withServer(async (baseUrl) => {
    const key = "anchorblockskey123";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    for (const id of ["blk-eli5", "blk-explainer-summary", "blk-step-0", "blk-step-1", "blk-dec-d1-text", "blk-dec-d1-why", "blk-dec-d1-alts", "blk-q-q1-prompt"]) {
      assert.match(html, new RegExp(`data-anchor-block="${id}"`), `missing anchor block ${id}`);
    }
  });
});

// The <li> wrapper's textContent includes the step number and the Agent/Human badge; anchoring
// there would put those characters into every offset.
test("anchor blocks: the id sits on the prose element, not the list item around it", async () => {
  await withServer(async (baseUrl) => {
    const key = "anchorinnerkey1234";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    assert.match(html, /<span class="walkthrough-text" data-anchor-block="blk-step-0"/);
    assert.match(html, /<div class="decision-text" data-anchor-block="blk-dec-d1-text"/);
    assert.doesNotMatch(html, /<li class="walkthrough-step[^>]*data-anchor-block/);
  });
});

test("anchor blocks: ids are deterministic across renders", async () => {
  await withServer(async (baseUrl) => {
    const key = "anchorstablekey123";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const first = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const second = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const ids = (html) => [...html.matchAll(/data-anchor-block="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids(first), ids(second));
  });
});

test("anchor blocks: two identical decision texts get distinct ids rather than colliding", async () => {
  await withServer(async (baseUrl) => {
    const key = "anchorcollidekey12";
    const quiz = {
      version: 3,
      questions: [],
      significance: "trivial",
      decisions: [
        { id: "same", who: "agent", decision: "Identical text", why: "" },
        { id: "same!", who: "agent", decision: "Identical text", why: "" },
      ],
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz });
    const html = await fetch(`${baseUrl}/session/${key}`).then((res) => res.text());
    const ids = [...html.matchAll(/data-anchor-block="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `expected unique ids, got ${ids.join(", ")}`);
  });
});

async function anchoredQuestion(baseUrl, key, anchor, threadId = "t-abc123") {
  return postJson(`${baseUrl}/api/${key}/prompts`, {
    prompts: [
      {
        uid: "",
        prompt: "what does this mean?",
        selector: "",
        tag: "message",
        text: "Question for the agent",
        target: { type: "message", thread_id: threadId, anchor },
      },
    ],
  });
}

test("anchored question: the passage and the whole thread reach the agent's poll payload", async () => {
  await withServer(async (baseUrl) => {
    const key = "anchoredaskkey1234";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const start = "The first step".length - 5;
    await anchoredQuestion(baseUrl, key, {
      kind: "text",
      block_id: "blk-step-0",
      block_kind: "walkthrough-step",
      start,
      end: start + 4,
      exact: "step",
      prefix: "",
      suffix: "",
    });
    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    const prompt = feedback.prompts[0];
    assert.equal(prompt.target.thread_id, "t-abc123");
    assert.equal(prompt.target.anchor.block_id, "blk-step-0");
    assert.equal(prompt.thread.id, "t-abc123");
    assert.equal(prompt.thread.quote, "step");
    assert.deepEqual(prompt.thread.turns.map((t) => t.text), ["what does this mean?"]);
  });
});

test("anchored question: a follow-up joins the same thread and the agent sees every earlier turn", async () => {
  await withServer(async (baseUrl) => {
    const key = "anchoredfollowkey1";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    await anchoredQuestion(baseUrl, key, { kind: "block", block_id: "blk-eli5", block_kind: "eli5", exact: "Plain words about the change." });
    await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    await postJson(`${baseUrl}/api/${key}/agent-reply`, { text: "because of X", thread_id: "t-abc123" });
    await anchoredQuestion(baseUrl, key, null);

    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    const turns = feedback.prompts[0].thread.turns;
    assert.deepEqual(
      turns.map((t) => [t.role, t.text]),
      [
        ["user", "what does this mean?"],
        ["agent", "because of X"],
        ["user", "what does this mean?"],
      ],
      "a bare follow-up must arrive with the whole thread, not on its own",
    );
    // The first turn's anchor stands for the thread; a follow-up does not overwrite it.
    assert.equal(feedback.prompts[0].thread.anchor.block_id, "blk-eli5");
  });
});

// Losing the agent's answer to a mistyped id is worse than filing it in the wrong place.
test("anchored question: an unknown thread id files the reply loose and says so, never errors", async () => {
  await withServer(async (baseUrl) => {
    const key = "unknownthreadkey12";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const res = await postJson(`${baseUrl}/api/${key}/agent-reply`, { text: "an answer", thread_id: "t-nosuchthread" });
    assert.equal(res.status, 200);
    assert.equal(res.body.thread_id, null);
    assert.equal(res.body.unknown_thread, true);
    const html = await fetch(`${baseUrl}/session/${key}`).then((res2) => res2.text());
    assert.match(html, /an answer/, "the reply must still be readable somewhere");
  });
});

test("anchored question: a diff anchor is rebuilt from the server's own parse, not the client's claim", async () => {
  await withServer(async (baseUrl) => {
    const key = "diffanchorkey12345";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    await anchoredQuestion(baseUrl, key, {
      kind: "diff",
      hunk_dom_id: "hunk-0",
      file: "f.js",
      side: "new",
      start_line: 2,
      end_line: 2,
      whole_hunk: false,
      exact: "TOTALLY WRONG TEXT THE CLIENT MADE UP",
    });
    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    assert.equal(feedback.prompts[0].target.anchor.exact, "added line", "the server must overwrite the client's text");
  });
});

// The one case where prose really does move under an anchor: same diff, corrected quiz.json,
// so the diffKey and the chat survive but the explainer text does not.
test("anchored question: a re-review that rewrites the prose marks the old anchor stale", async () => {
  await withServer(async (baseUrl) => {
    const key = "staleanchorkey1234";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const rewritten = {
      ...ANCHOR_QUIZ,
      explainer: { ...ANCHOR_QUIZ.explainer, walkthrough: [{ text: "Completely rewritten prose." }, { text: "The second step of the change." }] },
    };
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: rewritten });
    await anchoredQuestion(baseUrl, key, {
      kind: "text",
      block_id: "blk-step-0",
      block_kind: "walkthrough-step",
      start: 4,
      end: 9,
      exact: "first",
      prefix: "The ",
      suffix: " step",
    });
    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    const anchor = feedback.prompts[0].target.anchor;
    assert.equal(anchor.stale, true, "the quote is gone from that block, so it must be flagged");
    assert.equal(anchor.kind, "block", "and degraded to the whole block rather than pointing at new text");
  });
});

test("anchored question: a block that no longer exists is flagged rather than dropped", async () => {
  await withServer(async (baseUrl) => {
    const key = "goneblockkey123456";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    await anchoredQuestion(baseUrl, key, { kind: "text", block_id: "blk-step-99", block_kind: "walkthrough-step", start: 0, end: 4, exact: "gone" });
    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    assert.equal(feedback.prompts[0].target.anchor.stale, true);
    assert.equal(feedback.prompts[0].target.anchor.exact, "gone", "the human's quote must survive");
  });
});

test("anchored question: a garbage anchor from the browser is rejected at the boundary", async () => {
  await withServer(async (baseUrl) => {
    const key = "garbageanchorkey12";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    await anchoredQuestion(baseUrl, key, { kind: "text", block_id: "../../etc/passwd", start: -5, end: "x", exact: "y".repeat(9000) });
    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    assert.equal(feedback.prompts[0].target.anchor, undefined, "a malformed block_id must not survive normalization");
  });
});

test("anchored question: an over-long quote is capped rather than stored whole", async () => {
  await withServer(async (baseUrl) => {
    const key = "longquotekey123456";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    await anchoredQuestion(baseUrl, key, { kind: "block", block_id: "blk-step-99", block_kind: "k", exact: "z".repeat(9000) });
    const feedback = await fetch(`${baseUrl}/api/poll?key=${key}&timeoutMs=50`).then((res) => res.json());
    assert.ok(feedback.prompts[0].target.anchor.exact.length <= 2000);
  });
});

test("threads survive a re-review of the same diff, alongside chat and answers", async () => {
  await withServer(async (baseUrl, stateFile) => {
    const key = "threadsurvivekey12";
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    await anchoredQuestion(baseUrl, key, { kind: "block", block_id: "blk-eli5", block_kind: "eli5", exact: "Plain words about the change." });
    await postJson(`${baseUrl}/api/sessions`, { key, repo_root: "/repo", diff_text: DIFF_TEXT, diff_stat: {}, quiz: ANCHOR_QUIZ });
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(Object.keys(state.sessions[key].threads).length, 1);
    assert.equal(state.sessions[key].chat.length, 1);
  });
});
