import { readFile, rename, unlink, writeFile } from "node:fs/promises";

import { AxiError } from "axi-sdk-js";

export class SessionStore {
  constructor(file) {
    this.file = file;
    // Serializes this process's own mutations. Every method here is
    // read-modify-write over the WHOLE file, so two overlapping awaits would each read the
    // same starting state and the later write would silently discard the earlier one - or,
    // worse, interleave mid-write and leave torn JSON that every later command crashes on.
    // The browser answering a question while the agent's grade lands is exactly that case,
    // and it happens in one process, which is what this covers.
    this.queue = Promise.resolve();
  }

  // Runs `mutate` with exclusive access to the state, in order. Reads that only look
  // (findByKey, findReviewIndex) deliberately skip this - they are a single readFile and
  // stale-by-a-moment is fine for them.
  mutate(fn) {
    const run = this.queue.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      // `write: false` is how a no-op path (session not found, nothing to drain) avoids
      // rewriting the file it never changed.
      if (result?.write !== false) await this.writeState(state);
      return result?.value;
    });
    // The chain is deliberately swallowed here, never `run` itself: one mutation throwing
    // (gradeQuestion on an unanswered question, say) must not wedge every later one behind a
    // permanently-rejected promise. The caller still sees its own rejection through `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async readState() {
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {}, review_index: {} };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        sessions: parsed.sessions || {},
        review_index: parsed.review_index || {},
      };
    } catch (error) {
      // Naming the file matters more than usual here: the only way out is to delete it, and a
      // bare "Unexpected token" from deep inside a git hook tells the human nothing about
      // which file or that deleting it is safe (it costs past review records, nothing live).
      throw new AxiError(
        `quiz-axi state file is corrupt: ${this.file}`,
        "VALIDATION_ERROR",
        [
          error instanceof Error ? error.message : String(error),
          `Delete it to start fresh: rm ${this.file}`,
          "Past review records are lost, so any diff already reviewed needs reviewing again.",
        ],
      );
    }
  }

  // Written to a temp file and renamed, never in place. rename(2) is atomic on POSIX, so a
  // reader either sees the whole old file or the whole new one - a second writer (a CLI
  // command racing the detached server) can still lose an update, but can never leave a
  // half-written file behind that bricks every subsequent command.
  async writeState(state) {
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
  }

  async findByKey(key) {
    const state = await this.readState();
    return state.sessions[key] || null;
  }

  // Read directly, independent of any running server - this is what `quiz-axi verify` (the
  // husky pre-push hook) calls, since a git hook can't assume an agent/server is still alive.
  async findReviewIndex(key) {
    const state = await this.readState();
    return state.review_index[key] || null;
  }

  async upsertSession(key, { repoRoot, url, diffText, diffStat, quiz }) {
    return this.mutate((state) => {
      const existing = state.sessions[key] || {};
      const existingPrompts = existing.prompts || [];
      const existingStatus =
        existing.status === "ended" ? "open" : existing.status || "open";
      const answers = existing.answers || {};
      const session = {
        key,
        repo_root: repoRoot,
        url,
        status:
          existingStatus === "feedback" && existingPrompts.length === 0
            ? "open"
            : existingStatus,
        diff_text: diffText,
        diff_stat: diffStat,
        quiz,
        answers,
        score: computeScore(answers, quiz),
        pending_prompts: existing.pending_prompts || 0,
        prompts: existingPrompts,
        chat: existing.chat || [],
        threads: existing.threads || {},
        ...(existing.status === "ended" ? { ended_by: existing.ended_by } : {}),
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      if (!state.review_index[key]) {
        const now = new Date().toISOString();
        state.review_index[key] = {
          status: "pending",
          passed: null,
          score: session.score,
          repo_root: repoRoot,
          session_key: key,
          created_at: now,
          updated_at: now,
          finished_at: null,
        };
      }
      return { value: session };
    });
  }

  async queuePrompts(key, payload) {
    return this.mutate((state) => {
      const session = state.sessions[key];
      if (!session) {
        return { value: null, write: false };
      }
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      const shouldEndSession = Boolean(
        payload.endSession || payload.end_session,
      );
      const alreadyEnded = session.status === "ended";
      const normalizedPrompts = prompts.map(normalizePrompt);
      session.threads = session.threads || {};
      const userMessages = normalizedPrompts
        .filter((prompt) => prompt.tag === "message" && prompt.prompt)
        .map((prompt) => {
          const threadId =
            prompt.target?.type === "message" ? prompt.target.thread_id : "";
          const at = new Date().toISOString();
          if (threadId) {
            // First turn creates the thread and fixes its anchor; later turns join it and their
            // anchor (if any) is ignored - a follow-up is about the same passage by definition.
            if (!session.threads[threadId]) {
              session.threads[threadId] = {
                id: threadId,
                anchor: prompt.target.anchor || null,
                created_at: at,
              };
            }
            return {
              role: "user",
              text: prompt.prompt,
              at,
              id: newChatId(),
              thread_id: threadId,
            };
          }
          return { role: "user", text: prompt.prompt, at, id: newChatId() };
        });

      // Mirror quiz-answer prompts into session.answers immediately, so the browser/CLI can see
      // what was answered even before an agent grades it via `grade --question`. A new answer
      // always resets verdict/feedback/graded_at to null, even if this question was graded
      // before: it's a fresh submission (e.g. a retry after an incorrect verdict) and must not
      // inherit the previous answer's grade until it's actually re-graded.
      for (const prompt of normalizedPrompts) {
        if (
          prompt.tag === "quiz-answer" &&
          prompt.target?.type === "quiz-answer" &&
          prompt.target.question_id
        ) {
          const questionId = prompt.target.question_id;
          session.answers[questionId] = {
            value: prompt.target.choice_id ?? prompt.target.value ?? null,
            answered_at: new Date().toISOString(),
            verdict: null,
            feedback: null,
            graded_at: null,
          };
        }
      }

      session.score = computeScore(session.answers, session.quiz);
      session.prompts = [...(session.prompts || []), ...normalizedPrompts];
      session.chat = [...(session.chat || []), ...userMessages];
      session.pending_prompts = session.prompts.length;
      session.status = shouldEndSession || alreadyEnded ? "ended" : "feedback";
      if (shouldEndSession) session.ended_by = "user";
      session.updated_at = new Date().toISOString();
      if (state.review_index[key]) {
        state.review_index[key] = {
          ...state.review_index[key],
          score: session.score,
          updated_at: session.updated_at,
        };
      }
      return { value: session };
    });
  }

  async takeFeedback(key) {
    return this.mutate((state) => {
      const session = state.sessions[key];
      if (!session) {
        return { value: { status: "missing" }, write: false };
      }
      const prompts = session.prompts || [];
      const alreadyEnded = session.status === "ended";
      const outcome = alreadyEnded
        ? state.review_index[key]?.status
        : undefined; // "passed" | "failed" | "pending"
      if (prompts.length === 0) {
        return {
          value: alreadyEnded
            ? { status: "ended", ended_by: session.ended_by, outcome }
            : { status: "waiting" },
          write: false,
        };
      }
      const result = {
        status: "feedback",
        prompts: prompts.map((prompt) => enrichWithThread(prompt, session)),
        score: session.score,
        ...(alreadyEnded
          ? { session_ended: true, ended_by: session.ended_by, outcome }
          : {}),
      };
      session.prompts = [];
      session.pending_prompts = 0;
      if (!alreadyEnded) {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      return { value: result };
    });
  }

  async endSession(key, endedBy = "agent") {
    return this.mutate((state) => {
      const session = state.sessions[key];
      if (!session) {
        return { value: null, write: false };
      }
      session.status = "ended";
      session.ended_by = endedBy;
      session.updated_at = new Date().toISOString();
      return { value: session };
    });
  }

  // `threadId` is optional and NEVER validated into an error: an unknown id files the reply
  // loose and says so. Losing the agent's answer to a mistyped id would be a far worse
  // outcome than filing it in the wrong place, where the human can still read it.
  async addAgentReply(key, text, { threadId } = {}) {
    return this.mutate((state) => {
      const session = state.sessions[key];
      if (!session) {
        return { value: null, write: false };
      }
      const known = Boolean(threadId && session.threads?.[threadId]);
      const entry = {
        role: "agent",
        text: String(text || ""),
        at: new Date().toISOString(),
        id: newChatId(),
        ...(known ? { thread_id: threadId } : {}),
      };
      session.chat = [...(session.chat || []), entry];
      session.updated_at = new Date().toISOString();
      return {
        value: {
          session,
          thread_id: known ? threadId : null,
          ...(threadId && !known ? { unknown_thread: true } : {}),
        },
      };
    });
  }

  // Records the agent's live verdict for one already-answered question. Grading is always
  // agent-driven (never auto-graded, even for an objectively-correct multiple-choice pick).
  //
  // If this verdict makes every question correct, the session auto-finishes as "pass" and
  // auto-ends right here, so the agent doesn't need a separate `--finish pass` + `end` step
  // once the human has gotten everything right. Any question graded "incorrect" leaves the
  // session open so the human can retry it (queuePrompts resets a question's verdict to null
  // the moment it's re-answered, so a retry always needs fresh grading).
  async gradeQuestion(key, { questionId, verdict, feedback }) {
    return this.mutate((state) => {
      const session = state.sessions[key];
      if (!session) {
        return { value: null, write: false };
      }
      if (!session.answers?.[questionId]) {
        throw new AxiError(
          `No answer recorded yet for question "${questionId}"`,
          "VALIDATION_ERROR",
          [
            "Wait for the human to answer this question (poll again) before grading it",
          ],
        );
      }
      const now = new Date().toISOString();
      session.answers[questionId] = {
        ...session.answers[questionId],
        verdict,
        feedback: feedback || "",
        graded_at: now,
      };
      session.score = computeScore(session.answers, session.quiz);
      if (feedback) {
        // kind: a verdict answers a QUIZ CARD, which has its own feedback surface, so it stays
        // out of any thread. Tagging it keeps that distinction visible to the renderer.
        session.chat = [
          ...(session.chat || []),
          {
            role: "agent",
            text: feedback,
            at: now,
            id: newChatId(),
            kind: "grade",
          },
        ];
      }
      session.updated_at = now;
      if (state.review_index[key]) {
        state.review_index[key] = {
          ...state.review_index[key],
          score: session.score,
          updated_at: now,
        };
      }

      let autoFinished = false;
      if (
        session.score.total > 0 &&
        session.score.correct === session.score.total
      ) {
        sealReviewIndex(state, session, key, "pass", now);
        session.status = "ended";
        session.ended_by = "agent";
        autoFinished = true;
      }

      return { value: { session, autoFinished } };
    });
  }

  // Seals the review_index record `verify` reads - the only thing the husky pre-push gate
  // ever checks. `result` is "pass" or "fail".
  //
  // A "pass" requires every question to have been answered AND graded: otherwise an agent
  // could call `--finish pass` the instant a session opens, before the human looked at
  // anything, and the gate would wave the push through - defeating the entire point of the
  // tool. "fail" has no such requirement, since an incomplete review is itself a valid reason
  // to fail and ask the human to finish answering.
  async finishGrading(key, { result, summary }) {
    return this.mutate((state) => {
      const session = state.sessions[key];
      if (!session) {
        return { value: null, write: false };
      }
      if (result === "pass") {
        const totalQuestions = session.quiz?.questions?.length || 0;
        const gradedCount = Object.values(session.answers || {}).filter(
          (answer) =>
            answer.verdict === "correct" || answer.verdict === "incorrect",
        ).length;
        if (gradedCount < totalQuestions) {
          throw new AxiError(
            `Cannot finish as "pass": ${totalQuestions - gradedCount} of ${totalQuestions} question(s) are still unanswered or ungraded.`,
            "VALIDATION_ERROR",
            [
              "Grade every question with `grade <diff_key> --question <id> --verdict correct|incorrect` before finishing as pass.",
              'Finish as "fail" instead if the review is genuinely incomplete and the human should come back to it.',
            ],
          );
        }
      }
      const now = new Date().toISOString();
      if (summary) {
        session.chat = [
          ...(session.chat || []),
          {
            role: "agent",
            text: summary,
            at: now,
            id: newChatId(),
            kind: "summary",
          },
        ];
      }
      session.updated_at = now;
      sealReviewIndex(state, session, key, result, now);
      return { value: session };
    });
  }

  // Seals a diff as passed with no quiz session at all - meant for a human, at their own
  // keyboard, sealing a change they personally wrote and don't need to be quizzed on. Marked
  // `method: "self-authored"` (vs. "quiz" for a live-graded pass) so state.json and `verify`'s
  // output stay honest about which path produced the pass - this command can't be technically
  // prevented from being run by an agent instead of a human (same as git's own --no-verify
  // can't be), so visibility is the safeguard, not enforcement.
  async sealSelfAuthored(key, { repoRoot, summary }) {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      state.review_index[key] = {
        ...(state.review_index[key] || { session_key: key, created_at: now }),
        status: "passed",
        passed: true,
        method: "self-authored",
        summary: summary || "",
        repo_root: repoRoot,
        finished_at: now,
        updated_at: now,
      };
      return { value: state.review_index[key] };
    });
  }
}

function sealReviewIndex(state, session, key, result, now) {
  state.review_index[key] = {
    ...(state.review_index[key] || {
      repo_root: session.repo_root,
      session_key: key,
      created_at: now,
    }),
    status: result === "pass" ? "passed" : "failed",
    passed: result === "pass",
    method: "quiz",
    score: session.score,
    finished_at: now,
    updated_at: now,
  };
}

function computeScore(answers, quiz) {
  const values = Object.values(answers || {});
  return {
    answered: values.length,
    correct: values.filter((answer) => answer.verdict === "correct").length,
    total: quiz?.questions?.length || 0,
  };
}

function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target))
    return null;
  if (target.type === "quiz-answer") {
    const normalized = {
      type: "quiz-answer",
      question_id: String(target.question_id || ""),
    };
    if (target.choice_id !== undefined)
      normalized.choice_id = String(target.choice_id);
    if (target.value !== undefined) normalized.value = String(target.value);
    return normalized;
  }
  if (target.type === "message") {
    const normalized = { type: "message" };
    const threadId = String(target.thread_id || "");
    if (THREAD_ID_RE.test(threadId)) normalized.thread_id = threadId;
    const anchor = normalizeAnchor(target.anchor);
    if (anchor) normalized.anchor = anchor;
    return normalized;
  }
  // Anything unrecognized is still carried through structurally, as before - forward compat
  // for a target shape a newer client sends.
  return JSON.parse(JSON.stringify(target));
}

const THREAD_ID_RE = /^t-[a-z0-9-]{1,64}$/i;
const BLOCK_ID_RE = /^[a-z0-9-]{1,64}$/;
const DOM_ID_RE = /^hunk-\d{1,6}$/;

// The sanitize boundary for an anchor. Everything here arrives from the browser, so every
// field is coerced and every string capped - the old fallback deep-cloned whatever it was
// handed. Quotes are stored (they are what the thread displays even when the anchor goes
// stale), which is why `exact` gets the largest budget and still gets one.
function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor))
    return null;
  const clamp = (value, max) => String(value ?? "").slice(0, max);
  const int = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  if (anchor.kind === "diff") {
    if (!DOM_ID_RE.test(String(anchor.hunk_dom_id || ""))) return null;
    return {
      kind: "diff",
      hunk_dom_id: String(anchor.hunk_dom_id),
      file: clamp(anchor.file, 400),
      side: anchor.side === "old" ? "old" : "new",
      start_line: int(anchor.start_line),
      end_line: int(anchor.end_line),
      whole_hunk: Boolean(anchor.whole_hunk),
      exact: clamp(anchor.exact, 2000),
      ...(anchor.stale === undefined ? {} : { stale: Boolean(anchor.stale) }),
    };
  }
  const blockId = String(anchor.block_id || "");
  if (!BLOCK_ID_RE.test(blockId)) return null;
  const base = {
    block_id: blockId,
    block_kind: clamp(anchor.block_kind, 40),
    exact: clamp(anchor.exact, 2000),
    ...(anchor.stale === undefined ? {} : { stale: Boolean(anchor.stale) }),
  };
  if (anchor.kind === "block") return { kind: "block", ...base };
  return {
    kind: "text",
    ...base,
    start: int(anchor.start),
    end: int(anchor.end),
    prefix: clamp(anchor.prefix, 200),
    suffix: clamp(anchor.suffix, 200),
  };
}

// Hands the agent the whole thread alongside the prompt: the passage it is about, and every
// turn including this one. Without it a follow-up of "why?" arrives as literally the word
// "why?" and the agent has to guess what it refers to.
function enrichWithThread(prompt, session) {
  const threadId =
    prompt?.target?.type === "message" ? prompt.target.thread_id : "";
  const thread = threadId ? session.threads?.[threadId] : null;
  if (!thread) return prompt;
  return {
    ...prompt,
    thread: {
      id: thread.id,
      anchor: thread.anchor || null,
      quote: String(thread.anchor?.exact || ""),
      turns: (session.chat || [])
        .filter((entry) => entry.thread_id === threadId)
        .map((entry) => ({ role: entry.role, text: entry.text, at: entry.at })),
    },
  };
}

let chatIdCounter = 0;
// Ids only need to be unique within one session's chat array, and they are minted server-side
// where Date.now/Math.random are unremarkable. The counter guards the case of several entries
// landing inside the same millisecond, which one queued batch reliably does.
function newChatId() {
  chatIdCounter += 1;
  return `c-${Date.now().toString(36)}-${chatIdCounter.toString(36)}`;
}
