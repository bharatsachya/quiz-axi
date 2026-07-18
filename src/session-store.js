import { readFile, writeFile } from "node:fs/promises";

import { AxiError } from "axi-sdk-js";

export class SessionStore {
  constructor(file) {
    this.file = file;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {}, review_index: parsed.review_index || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {}, review_index: {} };
      }
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
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
    const state = await this.readState();
    const existing = state.sessions[key] || {};
    const existingPrompts = existing.prompts || [];
    const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
    const answers = existing.answers || {};
    const session = {
      key,
      repo_root: repoRoot,
      url,
      status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
      diff_text: diffText,
      diff_stat: diffStat,
      quiz,
      answers,
      score: computeScore(answers, quiz),
      pending_prompts: existing.pending_prompts || 0,
      prompts: existingPrompts,
      chat: existing.chat || [],
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
    await this.writeState(state);
    return session;
  }

  async queuePrompts(key, payload) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
    const shouldEndSession = Boolean(payload.endSession || payload.end_session);
    const alreadyEnded = session.status === "ended";
    const normalizedPrompts = prompts.map(normalizePrompt);
    const userMessages = normalizedPrompts
      .filter((prompt) => prompt.tag === "message" && prompt.prompt)
      .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));

    // Mirror quiz-answer prompts into session.answers immediately, so the browser/CLI can see
    // what was answered even before an agent grades it via `grade --question`. A new answer
    // always resets verdict/feedback/graded_at to null, even if this question was graded
    // before: it's a fresh submission (e.g. a retry after an incorrect verdict) and must not
    // inherit the previous answer's grade until it's actually re-graded.
    for (const prompt of normalizedPrompts) {
      if (prompt.tag === "quiz-answer" && prompt.target?.type === "quiz-answer" && prompt.target.question_id) {
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
      state.review_index[key] = { ...state.review_index[key], score: session.score, updated_at: session.updated_at };
    }
    await this.writeState(state);
    return session;
  }

  async takeFeedback(key) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return { status: "missing" };
    }
    const prompts = session.prompts || [];
    const alreadyEnded = session.status === "ended";
    const outcome = alreadyEnded ? state.review_index[key]?.status : undefined; // "passed" | "failed" | "pending"
    if (prompts.length === 0) {
      return alreadyEnded ? { status: "ended", ended_by: session.ended_by, outcome } : { status: "waiting" };
    }
    const result = {
      status: "feedback",
      prompts,
      score: session.score,
      ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by, outcome } : {}),
    };
    session.prompts = [];
    session.pending_prompts = 0;
    if (!alreadyEnded) {
      session.status = "open";
    }
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return result;
  }

  async endSession(key, endedBy = "agent") {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    session.status = "ended";
    session.ended_by = endedBy;
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  async addAgentReply(key, text) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    session.chat = [...(session.chat || []), { role: "agent", text: String(text || ""), at: new Date().toISOString() }];
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
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
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    if (!session.answers?.[questionId]) {
      throw new AxiError(`No answer recorded yet for question "${questionId}"`, "VALIDATION_ERROR", [
        "Wait for the human to answer this question (poll again) before grading it",
      ]);
    }
    const now = new Date().toISOString();
    session.answers[questionId] = { ...session.answers[questionId], verdict, feedback: feedback || "", graded_at: now };
    session.score = computeScore(session.answers, session.quiz);
    if (feedback) {
      session.chat = [...(session.chat || []), { role: "agent", text: feedback, at: now }];
    }
    session.updated_at = now;
    if (state.review_index[key]) {
      state.review_index[key] = { ...state.review_index[key], score: session.score, updated_at: now };
    }

    let autoFinished = false;
    if (session.score.total > 0 && session.score.correct === session.score.total) {
      sealReviewIndex(state, session, key, "pass", now);
      session.status = "ended";
      session.ended_by = "agent";
      autoFinished = true;
    }

    await this.writeState(state);
    return { session, autoFinished };
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
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    if (result === "pass") {
      const totalQuestions = session.quiz?.questions?.length || 0;
      const gradedCount = Object.values(session.answers || {}).filter(
        (answer) => answer.verdict === "correct" || answer.verdict === "incorrect",
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
      session.chat = [...(session.chat || []), { role: "agent", text: summary, at: now }];
    }
    session.updated_at = now;
    sealReviewIndex(state, session, key, result, now);
    await this.writeState(state);
    return session;
  }

  // Seals a diff as passed with no quiz session at all - meant for a human, at their own
  // keyboard, sealing a change they personally wrote and don't need to be quizzed on. Marked
  // `method: "self-authored"` (vs. "quiz" for a live-graded pass) so state.json and `verify`'s
  // output stay honest about which path produced the pass - this command can't be technically
  // prevented from being run by an agent instead of a human (same as git's own --no-verify
  // can't be), so visibility is the safeguard, not enforcement.
  async sealSelfAuthored(key, { repoRoot, summary }) {
    const now = new Date().toISOString();
    const state = await this.readState();
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
    await this.writeState(state);
    return state.review_index[key];
  }
}

function sealReviewIndex(state, session, key, result, now) {
  state.review_index[key] = {
    ...(state.review_index[key] || { repo_root: session.repo_root, session_key: key, created_at: now }),
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
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "quiz-answer") {
    const normalized = { type: "quiz-answer", question_id: String(target.question_id || "") };
    if (target.choice_id !== undefined) normalized.choice_id = String(target.choice_id);
    if (target.value !== undefined) normalized.value = String(target.value);
    return normalized;
  }
  return JSON.parse(JSON.stringify(target));
}
