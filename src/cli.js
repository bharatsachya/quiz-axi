import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError, installSessionStartHooks, runAxiCli } from "axi-sdk-js";

import { computeCurrentDiff, computeRangeDiff, diffKey, parsePrePushStdin } from "./diff.js";
import { clientHost, defaultPort, ensureStateDir, hostForUrl, serverLogFile, stateFile } from "./paths.js";
import { loadQuizSpec, matchHunkAnchors } from "./quiz.js";
import { serve } from "./server.js";
import { SessionStore } from "./session-store.js";

const DESCRIPTION =
  "quiz-axi quizzes a human reviewer on an AI agent's code diff, then gates `git push` on passing it via a husky " +
  "pre-push hook. After making a code change, generate a quiz.json with questions about that diff (anchored to " +
  'specific hunks where useful), then run `quiz-axi review --quiz <quiz.json>` so the human can review the diff, ' +
  "answer questions, and ask follow-up questions, while you grade live through `quiz-axi poll`.";

export const POLL_WAKE_PATH_RULES = Object.freeze([
  "Keep the poll in the foreground by default and let it return activity directly to the agent.",
  "A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.",
  "Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.",
  "If the poll gets killed or times out anyway, just re-run it - queued activity is never lost.",
]);
const CODEX_POLL_WAKE_PATH_GUIDANCE =
  "Codex detected: completed background tasks may not resume Codex automatically, so keep the poll attached to the active turn.";

// There is no build step (quiz-axi runs unbundled from src/), so package.json's version alone
// never changes while iterating on source. `ensureServer()` only restarts an already-running
// detached server on a version mismatch, so without this, editing server.js while the old
// server is still up silently keeps serving the OLD in-memory code indefinitely. Folding in the
// latest mtime across src/+bin/ makes every source edit change VERSION, so the next CLI
// invocation always detects the mismatch and restarts the stale server automatically.
function computeSourceFingerprint() {
  let latestMtimeMs = 0;
  for (const dirUrl of [new URL("../src", import.meta.url), new URL("../bin", import.meta.url)]) {
    const dir = fileURLToPath(dirUrl);
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".js") && !entry.endsWith(".css")) continue;
      const mtimeMs = statSync(path.join(dir, entry)).mtimeMs;
      if (mtimeMs > latestMtimeMs) latestMtimeMs = mtimeMs;
    }
  }
  return Math.round(latestMtimeMs).toString(36);
}

export const VERSION = `${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}+${computeSourceFingerprint()}`;

export function detectInvokingAgent(env = process.env) {
  return ["CODEX_SANDBOX", "CODEX_THREAD_ID"].some((key) => Object.hasOwn(env, key)) ? "codex" : "generic";
}

export function pollExecutionGuidance({ agent = "generic" } = {}) {
  const sharedGuidance = POLL_WAKE_PATH_RULES.join(" ");
  const agentGuidance = agent === "codex" ? ` ${CODEX_POLL_WAKE_PATH_GUIDANCE}` : "";
  return `${sharedGuidance}${agentGuidance}`;
}

export async function run(argv) {
  await ensureStateDir();
  const agent = detectInvokingAgent(process.env);
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: createTopLevelHelp({ agent }),
    home: async () =>
      createHomeOutput({ bin: process.argv[1] || "quiz-axi", sessions: await visibleSessions(), agent }),
    commands: {
      review: reviewCommand,
      poll: pollCommand,
      grade: gradeCommand,
      end: endCommand,
      verify: verifyCommand,
      stop: stopCommand,
      server: serverCommand,
      setup: setupCommand,
    },
    getCommandHelp: (command) => getCommandHelp(command, { agent }),
  });
}

export function collapseHomeDirectory(file, home) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  if (normalizedFile === normalizedHome) return "~";
  if (normalizedFile.startsWith(`${normalizedHome}/`)) return `~/${normalizedFile.slice(normalizedHome.length + 1)}`;
  return file;
}

export function createHomeOutput({ bin, sessions, agent = "generic" }) {
  return {
    bin: collapseHomeDirectory(bin, os.homedir()),
    description: DESCRIPTION,
    sessions: sessions.map((session) => ({
      diff_key: session.key,
      status: session.status,
      url: session.url,
      score: session.score,
    })),
    help: [
      'Run `quiz-axi review --quiz <quiz.json> [--base <ref>] [--no-open]` to open a review session for the current diff (working tree vs. the resolved base branch). `git add` any new files you want included first - untracked files are deliberately excluded so the reviewed diff always matches what a later `git push` actually sends; write quiz.json itself outside the repo (or gitignore it) so it never becomes part of the diff it describes. quiz.json is a JSON file you generate: {"questions":[{"id","type":"multiple-choice"|"free-text","prompt","choices"?,"hunk_anchor"?:{"file","start_line","end_line"}}]}. There is no answer key field - grading is always live, never auto-graded.',
      '`quiz-axi review --self-authored [--summary "..."]` seals the current diff as passed with no quiz at all - for a human sealing a change they personally wrote themselves, at their own keyboard. Agents must never run --self-authored on their own initiative to skip a review; it is not a substitute for the quiz workflow above.',
      `Run \`quiz-axi poll <diff_key>\` to wait for the human to answer a question, ask a free-text question back, or end the session. It long-polls and stays silent until something happens - leave it running, never kill it. ${pollExecutionGuidance({ agent })}`,
      "Run `quiz-axi grade <diff_key> --question <id> --verdict correct|incorrect [--feedback \"...\"]` to record your live verdict for one answered question, then poll again.",
      'Run `quiz-axi grade <diff_key> --finish pass|fail [--summary "..."]` once the human is done - this is the record `quiz-axi verify` (the husky pre-push gate) checks before allowing `git push`. If the diff changes again afterward, the new diff has no review record and the gate re-blocks - that is intentional integrity, not a bug.',
      "Run `quiz-axi end <diff_key>` to end a review session as the agent.",
      "`quiz-axi verify` is what the `.husky/pre-push` hook calls - it never talks to this CLI's server, it reads the review record straight off disk, so it works even if no agent/server is running when the human pushes.",
      "Run `quiz-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected).",
      '`quiz-axi setup hooks` installs *agent* SessionStart hooks (ambient context at the start of a session) for Claude Code, Codex, and OpenCode. This is unrelated to the *git* hooks in `.husky/` that gate `git push` - both are called "hooks" but are different mechanisms.',
      "Use quiz-axi after making a code change the user should understand before it ships, especially AI-generated changes - it helps them connect to the actual diff instead of taking your summary on faith.",
    ],
  };
}

async function reviewCommand(args) {
  const baseOverride = flagValue(args, "--base") || undefined;

  // Meant to be typed by a human, at their own keyboard, for a change they personally wrote and
  // don't need to be quizzed on - not something an agent should ever invoke on its own
  // initiative to dodge a review. Nothing technically stops an agent from running this anyway
  // (same as nothing stops `git push --no-verify`); the review_index `method: "self-authored"`
  // marker is a visibility safeguard, not an enforcement one.
  if (args.includes("--self-authored")) {
    const { repoRoot, diffText } = computeCurrentDiff({ baseOverride });
    if (diffText.trim() === "") {
      throw new AxiError("No diff to seal - the working tree matches the base branch", "VALIDATION_ERROR");
    }
    const key = diffKey({ repoRoot, diffText });
    const summary = flagValue(args, "--summary") || "";
    const store = new SessionStore(stateFile());
    await store.sealSelfAuthored(key, { repoRoot, summary });
    return createSelfAuthoredOutput({ diffKey: key });
  }

  const quizPath = flagValue(args, "--quiz");
  if (!quizPath) {
    throw new AxiError("--quiz <path> is required", "VALIDATION_ERROR", ["Run `quiz-axi review --quiz <quiz.json>`"]);
  }
  const { repoRoot, diffText, stat } = computeCurrentDiff({ baseOverride });
  if (diffText.trim() === "") {
    throw new AxiError("No diff to review - the working tree matches the base branch", "VALIDATION_ERROR", [
      "Make a code change first, then run `quiz-axi review --quiz <quiz.json>`",
    ]);
  }
  const rawQuiz = await loadQuizSpec(quizPath);
  const quiz = matchHunkAnchors(rawQuiz, diffText);
  const key = diffKey({ repoRoot, diffText });
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/sessions`, {
    key,
    repo_root: repoRoot,
    diff_text: diffText,
    diff_stat: stat,
    quiz,
  });
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
    } catch {
      response.status = "ready";
    }
  }
  return createReviewOutput({ diffKey: key, url: response.url, status: response.status || "opened" });
}

export function shouldOpenBrowser(args, env) {
  return !args.includes("--no-open") && env.QUIZ_AXI_NO_OPEN !== "1";
}

export function createSelfAuthoredOutput({ diffKey: key }) {
  return {
    review: { diff_key: key, status: "sealed", method: "self-authored", passed: true },
    next_step:
      `Sealed as passed with no quiz - this diff is now clear to \`git push\`, as long as it doesn't change again ` +
      `before then. This command is meant for a human to run themselves for a change they personally wrote; agents ` +
      `should not run \`--self-authored\` on their own to skip a review.`,
  };
}

export function createReviewOutput({ diffKey: key, url, status }) {
  return {
    review: { diff_key: key, url, status },
    next_step:
      `Do not respond to the user just yet. Now you must run \`quiz-axi poll ${key}\`. This long-polls until the ` +
      `human answers a question, asks a free-text question back, or ends the session, and it stays silent the whole ` +
      `time - that is normal, never kill it. Grade each answered question live with \`quiz-axi grade ${key} ` +
      `--question <id> --verdict correct|incorrect [--feedback "..."]\`, then keep polling. When the human is done, ` +
      `finish the review with \`quiz-axi grade ${key} --finish pass|fail [--summary "..."]\` - this is what ` +
      `\`quiz-axi verify\` (the husky pre-push gate) checks before allowing \`git push\`.`,
  };
}

async function pollCommand(args) {
  const key = firstPositionalArg(args, ["--agent-reply", "--timeout-ms"]);
  if (!key) {
    throw new AxiError("diff_key is required", "VALIDATION_ERROR", ["Run `quiz-axi poll <diff_key>`"]);
  }
  const baseUrl = await ensureServer();
  const agentReply = flagValue(args, "--agent-reply");
  if (agentReply) {
    await postJson(`${baseUrl}/api/${key}/agent-reply`, { text: agentReply });
  }
  const timeoutMs = flagValue(args, "--timeout-ms");
  const timeoutQuery = timeoutMs ? `&timeoutMs=${encodeURIComponent(timeoutMs)}` : "";
  const onPollSignal = (signal) => {
    process.stderr.write(`\n${pollInterruptedText(key)}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (!timeoutMs) {
    process.on("SIGINT", onPollSignal);
    process.on("SIGTERM", onPollSignal);
  }
  const waitReporter = timeoutMs ? null : startPollWaitReporter({ diffKey: key });
  try {
    const response = await fetchJson(`${baseUrl}/api/poll?key=${encodeURIComponent(key)}${timeoutQuery}`, {
      retries: 3,
      retryDelayMs: 500,
    });
    return createPollOutput({ diffKey: key, response, agent: detectInvokingAgent(process.env) });
  } finally {
    waitReporter?.stop();
    if (!timeoutMs) {
      process.off("SIGINT", onPollSignal);
      process.off("SIGTERM", onPollSignal);
    }
  }
}

export function pollWaitBannerText(diffKeyArg) {
  return (
    `[quiz-axi] Long-polling for human activity on ${diffKeyArg}. This stays silent until the human answers a ` +
    `question, asks something, or ends the session - leave it running. If it gets killed or times out, re-run ` +
    `\`quiz-axi poll ${diffKeyArg}\` - queued activity is never lost.`
  );
}

export function pollWaitTickText(elapsedMs) {
  const minutes = Math.round(elapsedMs / 60_000);
  return `[quiz-axi] Still waiting for human activity (${minutes}m). Leave this running until the human acts.`;
}

export function pollInterruptedText(diffKeyArg) {
  return (
    `[quiz-axi] Poll interrupted before human activity arrived. The human may still be reviewing - ` +
    `re-run \`quiz-axi poll ${diffKeyArg}\` to keep waiting; queued activity is never lost.`
  );
}

export function startPollWaitReporter({
  diffKey: key,
  write = (line) => {
    process.stderr.write(line);
  },
  intervalMs = 60_000,
}) {
  write(`${pollWaitBannerText(key)}\n`);
  let elapsedMs = 0;
  const timer = setInterval(() => {
    elapsedMs += intervalMs;
    write(`${pollWaitTickText(elapsedMs)}\n`);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function createPollOutput({ diffKey: key, response, agent = "generic" }) {
  if (response.status === "missing") {
    throw new AxiError("No active quiz-axi review session for this diff_key", "NOT_FOUND", [
      "Run `quiz-axi review --quiz <quiz.json>` first",
    ]);
  }
  if (response.status === "feedback") {
    const sessionEnded = Boolean(response.session_ended);
    const endedBy = typeof response.ended_by === "string" ? response.ended_by : undefined;
    return {
      session: {
        diff_key: key,
        status: "feedback",
        score: response.score,
        ...(sessionEnded ? { session_ended: true, ...(endedBy ? { ended_by: endedBy } : {}) } : {}),
      },
      prompts: response.prompts || [],
      next_step: createFeedbackNextStep(key, sessionEnded, endedBy, response.prompts || [], agent, response.outcome),
    };
  }
  if (response.status === "ended") {
    return {
      session: { diff_key: key, status: "ended", ...(response.ended_by ? { ended_by: response.ended_by } : {}) },
      next_step: createEndedNextStep(key, response.ended_by, response.outcome),
    };
  }
  return {
    session: { diff_key: key, status: response.status || "waiting" },
    next_step: `No activity arrived before the optional timeout. Run \`quiz-axi poll ${key}\` without --timeout-ms to wait indefinitely - queued activity is never lost.`,
  };
}

function createFeedbackNextStep(key, sessionEnded, endedBy, prompts, agent, outcome) {
  const hasAnswers = prompts.some((prompt) => prompt.tag === "quiz-answer");
  const hasQuestions = prompts.some((prompt) => prompt.tag === "message");
  const parts = [];
  if (hasAnswers) {
    parts.push(
      `One or more questions were just answered (tag "quiz-answer" - see prompts[].target.question_id and ` +
        `.choice_id/.value). Grade each with \`quiz-axi grade ${key} --question <id> --verdict correct|incorrect ` +
        `[--feedback "..."]\`.`,
    );
  }
  if (hasQuestions) {
    parts.push(
      `The human asked something back (tag "message"). Reply with \`quiz-axi poll ${key} --agent-reply ` +
        `"<message>"\` on your next poll.`,
    );
  }
  if (sessionEnded) {
    parts.push(
      endedBy === "user"
        ? `This was the last activity before the human ended the session. Stop polling ${key}.`
        : `This was the last activity before the session ended. Stop polling ${key}.`,
    );
    parts.push(finishReminder(key, outcome));
    return parts.join(" ");
  }
  parts.push(
    `Do not respond to the user just yet. Now run \`quiz-axi poll ${key}\` again (without --timeout-ms) and keep ` +
      `waiting - never kill it. ${pollExecutionGuidance({ agent })}`,
  );
  return parts.join(" ");
}

function createEndedNextStep(key, endedBy, outcome) {
  const base =
    endedBy === "user"
      ? `The human ended this quiz-axi review session. Stop polling ${key}.`
      : `This quiz-axi review session for ${key} has ended. Stop polling.`;
  return `${base} ${finishReminder(key, outcome)}`;
}

// Grading the last question correct auto-finishes the review as passed and auto-ends the
// session (see SessionStore.gradeQuestion) - the browser even shows a "review passed, you can
// close this tab" screen on its own. Only tell the agent to run `--finish` when that did NOT
// already happen, so a successful auto-finish doesn't get a spurious "you forgot a step" nudge.
function finishReminder(key, outcome) {
  if (outcome === "passed") {
    return (
      `The review already auto-finished as PASSED (every question was answered and graded correct) - the diff ` +
      `is clear to push. Nothing further to run here.`
    );
  }
  if (outcome === "failed") {
    return `This review is already sealed as FAILED. Re-review with \`quiz-axi review\` once the human is ready to try again.`;
  }
  return (
    `If the review was never finished, still run \`quiz-axi grade ${key} --finish pass|fail\` so \`quiz-axi ` +
    `verify\` has a record before the human tries to push.`
  );
}

async function gradeCommand(args) {
  const key = firstPositionalArg(args, ["--question", "--verdict", "--feedback", "--finish", "--summary"]);
  if (!key) {
    throw new AxiError("diff_key is required", "VALIDATION_ERROR", [
      "Run `quiz-axi grade <diff_key> --question <id> --verdict correct|incorrect`",
      "Or `quiz-axi grade <diff_key> --finish pass|fail`",
    ]);
  }
  const baseUrl = await ensureServer();
  const finish = flagValue(args, "--finish");
  if (finish) {
    if (finish !== "pass" && finish !== "fail") {
      throw new AxiError('--finish must be "pass" or "fail"', "VALIDATION_ERROR");
    }
    const summary = flagValue(args, "--summary") || "";
    const response = await postJson(`${baseUrl}/api/${key}/grade`, { finish, summary });
    return {
      grade: { diff_key: key, finished: response.finished, score: response.score },
      next_step:
        finish === "pass"
          ? `The diff is now marked passed for \`quiz-axi verify\` (the husky pre-push gate) - it's clear to push, ` +
            `as long as the diff doesn't change again before then. Keep polling \`quiz-axi poll ${key}\` in case ` +
            `the human asks a follow-up question, or run \`quiz-axi end ${key}\` if the human is done.`
          : `The diff is marked failed. Explain the gap to the user in this conversation, then keep polling ` +
            `\`quiz-axi poll ${key}\` for another attempt, or run \`quiz-axi end ${key}\`.`,
    };
  }
  const questionId = flagValue(args, "--question");
  const verdict = flagValue(args, "--verdict");
  if (!questionId || (verdict !== "correct" && verdict !== "incorrect")) {
    throw new AxiError(
      "--question <id> and --verdict correct|incorrect are required (or use --finish pass|fail)",
      "VALIDATION_ERROR",
    );
  }
  const feedback = flagValue(args, "--feedback") || "";
  const response = await postJson(`${baseUrl}/api/${key}/grade`, { question_id: questionId, verdict, feedback });
  return {
    grade: { diff_key: key, question_id: response.question_id, verdict: response.verdict, score: response.score },
    next_step: `Run \`quiz-axi poll ${key}\` again to see if the human has more answers or questions.`,
  };
}

async function endCommand(args) {
  const key = firstPositionalArg(args);
  if (!key) {
    throw new AxiError("diff_key is required", "VALIDATION_ERROR", ["Run `quiz-axi end <diff_key>`"]);
  }
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/end`, { key });
  return { session: { diff_key: key, status: response.status || "ended" } };
}

// The husky pre-push gate. Deliberately server-independent: reads review_index straight off
// state.json, since a git hook must work even if no agent/server is alive when the human pushes.
async function verifyCommand(args) {
  const baseOverride = flagValue(args, "--base") || undefined;
  const store = new SessionStore(stateFile());
  const toSha = flagValue(args, "--to");
  let refs = [];
  if (toSha) {
    refs = [{ localRef: "HEAD", localSha: toSha }];
  } else if (!process.stdin.isTTY) {
    refs = parsePrePushStdin(await readStdin());
  }
  if (refs.length === 0) {
    const { repoRoot, diffText } = computeCurrentDiff({ baseOverride });
    const key = diffKey({ repoRoot, diffText });
    const result = await verifyOneDiff(store, key, "current working tree");
    if (!result.ok) {
      throw new AxiError("quiz-axi review gate failed", "VALIDATION_ERROR", [result.message]);
    }
    return { verify: { status: "passed", refs: [{ ref: result.ref, diff_key: result.key, method: result.method }] } };
  }
  const results = [];
  for (const ref of refs) {
    const { repoRoot, diffText } = computeRangeDiff({ localSha: ref.localSha, baseOverride });
    const key = diffKey({ repoRoot, diffText });
    results.push(await verifyOneDiff(store, key, ref.localRef));
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new AxiError("quiz-axi review gate failed", "VALIDATION_ERROR", failed.map((result) => result.message));
  }
  return {
    verify: {
      status: "passed",
      refs: results.map((result) => ({ ref: result.ref, diff_key: result.key, method: result.method })),
    },
  };
}

export async function verifyOneDiff(store, key, refLabel) {
  const record = await store.findReviewIndex(key);
  if (!record) {
    return {
      ok: false,
      ref: refLabel,
      key,
      message: `${refLabel}: no quiz review found for this diff (${key}). Run \`quiz-axi review --quiz <quiz.json>\` before pushing.`,
    };
  }
  if (record.status === "passed") {
    return { ok: true, ref: refLabel, key, method: record.method || "quiz" };
  }
  const score = record.score || { correct: 0, total: 0 };
  if (record.status === "failed") {
    return {
      ok: false,
      ref: refLabel,
      key,
      message: `${refLabel}: this diff was reviewed and marked FAILED (score ${score.correct}/${score.total}). Address the feedback and run \`quiz-axi review\` again.`,
    };
  }
  return {
    ok: false,
    ref: refLabel,
    key,
    message: `${refLabel}: a quiz review is in progress for this diff (score ${score.correct}/${score.total}) but was never finished. Run \`quiz-axi grade ${key} --finish pass|fail\`, or re-review if the code changed since.`,
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export async function stopCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  return shutdownServerOnPort(port, { baseUrl, currentVersion: VERSION });
}

export async function shutdownServerOnPort(
  port,
  {
    baseUrl = `http://${hostForUrl(clientHost())}:${port}`,
    currentVersion = VERSION,
    fetchHealth: healthFetcher = fetchHealth,
    requestShutdown: shutdownRequester = requestShutdown,
    waitForPortFree: portFreeWaiter = waitForPortFree,
    killProcessOnPort: portKiller = killProcessOnPort,
    processMatchesQuizAxi = processOnPortMatchesQuizAxi,
  } = {},
) {
  const health = await healthFetcher(baseUrl);
  if (!health) {
    return { server: { status: "not-running", port } };
  }
  if (!(await canControlServerOnPort(port, health, processMatchesQuizAxi))) {
    return { server: { status: "not-quiz-axi", port } };
  }
  await shutdownRequester(baseUrl);
  let freed = await portFreeWaiter(baseUrl, 3000);
  if (!freed && shouldKillProcessOnPort(currentVersion, health)) {
    portKiller(port);
    freed = await portFreeWaiter(baseUrl, 3000);
  }
  return { server: { status: freed ? "stopped" : "stopping", port } };
}

async function setupCommand(args) {
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", ["Run `quiz-axi setup hooks`"]);
  }
  const errors = [];
  installSessionStartHooks({
    marker: "quiz-axi",
    binaryNames: ["quiz-axi"],
    distEntrypoints: ["bin/quiz-axi.js"],
    homeDir: resolveHookHomeDir(),
    onError: (message) => errors.push(message),
  });
  if (errors.length > 0) {
    throw new AxiError("Failed to install quiz-axi agent hooks", "SERVER_ERROR", errors);
  }
  return {
    hooks: { status: "installed", integrations: "Claude Code, Codex, OpenCode" },
    help: [
      "Restart your agent session to receive quiz-axi ambient context.",
      'Note: this installs *agent* SessionStart hooks (ambient context at the start of a session) - unrelated to ' +
        'the *git* hooks in .husky/ that gate `git push`. Both are called "hooks" but are different mechanisms.',
    ],
  };
}

export function resolveHookHomeDir(env = process.env, fallback = os.homedir()) {
  return env.HOME || fallback;
}

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const debug = args.includes("--verbose") || process.env.QUIZ_AXI_DEBUG === "1";
  const server = await serve({ port, stateFile: stateFile(), version: VERSION, debug });
  await server.done;
  return "";
}

async function visibleSessions() {
  const store = new SessionStore(stateFile());
  return (await store.listSessions()).filter((session) => session.status !== "ended");
}

async function ensureServer() {
  const port = defaultPort();
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  const existing = await fetchHealth(baseUrl);
  if (existing && !shouldRestartServer(VERSION, existing)) {
    return baseUrl;
  }
  if (existing) {
    if (!(await canControlServerOnPort(port, existing, processOnPortMatchesQuizAxi))) {
      throw new AxiError(`Port ${port} is occupied by a non-quiz-axi server`, "SERVER_ERROR", [
        `Stop the process using port ${port}, or set QUIZ_AXI_PORT to another port`,
      ]);
    }
    await requestShutdown(baseUrl);
    const freed = await waitForPortFree(baseUrl, 2000);
    if (!freed && shouldKillProcessOnPort(VERSION, existing)) {
      killProcessOnPort(port);
      await waitForPortFree(baseUrl, 3000);
    }
  }
  await startServer(port);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl);
    if (health && !shouldRestartServer(VERSION, health)) {
      return baseUrl;
    }
    await delay(100);
  }
  throw new AxiError("quiz-axi server did not start", "SERVER_ERROR", [
    `Run \`quiz-axi server --port ${port}\` to inspect server startup`,
  ]);
}

export function shouldRestartServer(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  return healthBody.version !== currentVersion;
}

export function shouldKillProcessOnPort(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  if (healthBody.app !== "quiz-axi") return false;
  return healthBody.version !== currentVersion;
}

async function canControlServerOnPort(port, healthBody, processMatchesQuizAxi) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (healthBody.app === "quiz-axi") return true;
  if (typeof healthBody.version === "string" && healthBody.version !== "") return false;
  return processMatchesQuizAxi(port);
}

async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function requestShutdown(baseUrl) {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // Best effort. If the server died before answering, the port will free up on its own.
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) return true;
    await delay(100);
  }
  return false;
}

// macOS/Linux only, same caveat as the pattern this was ported from.
function killProcessOnPort(port) {
  try {
    const result = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process already gone or permission denied.
        }
      }
    }
  } catch {
    // lsof missing or unsupported platform.
  }
}

function processOnPortMatchesQuizAxi(port) {
  try {
    const pids = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (pids.status !== 0) return false;
    for (const line of pids.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.status === 0 && /quiz-axi/.test(command.stdout)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function startServer(port) {
  await ensureStateDir();
  const entry = fileURLToPath(new URL("../bin/quiz-axi.js", import.meta.url));
  let logFd = null;
  try {
    logFd = openSync(serverLogFile(), "a");
  } catch {
    // If logging cannot be initialized, keep the server behavior unchanged.
  }
  try {
    const child = spawn(process.execPath, [entry, "server", "--port", String(port)], createServerSpawnOptions(logFd));
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

export function createServerSpawnOptions(logFd = null) {
  const stdio = logFd === null ? "ignore" : ["ignore", logFd, logFd];
  return {
    detached: true,
    stdio,
    env: { ...process.env, QUIZ_AXI_NO_OPEN: "1" },
  };
}

export async function fetchJson(url, { retries = 0, retryDelayMs = 250 } = {}) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      response = await fetch(url);
      break;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw serverConnectionError();
      await delay(retryDelayMs);
    }
  }
  if (!response) throw serverConnectionError();
  if (!response.ok) {
    throw new AxiError(`quiz-axi request failed: ${response.status}`, "SERVER_ERROR");
  }
  try {
    return await response.json();
  } catch {
    throw pollResponseInterruptedError();
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw serverConnectionError();
  }
  if (!response.ok) {
    let message = `quiz-axi request failed: ${response.status}`;
    try {
      const body2 = await response.json();
      if (body2?.error) message = body2.error;
    } catch {
      // keep the generic message
    }
    throw new AxiError(message, "SERVER_ERROR");
  }
  return response.json();
}

function serverConnectionError() {
  return new AxiError("quiz-axi server connection failed", "SERVER_ERROR", [
    "Run `quiz-axi server --verbose` or inspect `~/.quiz-axi/server.log` (`QUIZ_AXI_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `quiz-axi poll <diff_key>` command after the server is healthy",
  ]);
}

function pollResponseInterruptedError() {
  return new AxiError("quiz-axi poll response was interrupted", "SERVER_ERROR", [
    "Run `quiz-axi server --verbose` or inspect `~/.quiz-axi/server.log` (`QUIZ_AXI_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `quiz-axi poll <diff_key>` command after the server is healthy",
  ]);
}

function firstPositionalArg(args, valueFlags = []) {
  const flags = new Set(valueFlags);
  let positionalMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalMode && arg === "--") {
      positionalMode = true;
      continue;
    }
    if (!positionalMode && isValueFlagToken(arg, flags)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (!positionalMode && arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === flag) return args[i + 1] || null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
  }
  return null;
}

function isValueFlagToken(arg, flags) {
  for (const flag of flags) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCommandHelp(command, { agent = "generic" } = {}) {
  return createCommandHelp({ agent })[command] || null;
}

function createTopLevelHelp({ agent = "generic" } = {}) {
  return `quiz-axi - quiz-axi AXI\n\nUsage:\n  quiz-axi\n  quiz-axi review --quiz <quiz.json> [--base <ref>] [--no-open]\n  quiz-axi review --self-authored [--summary "..."]\n  quiz-axi poll <diff_key> [--agent-reply "..."]\n  quiz-axi grade <diff_key> --question <id> --verdict correct|incorrect [--feedback "..."]\n  quiz-axi grade <diff_key> --finish pass|fail [--summary "..."]\n  quiz-axi end <diff_key>\n  quiz-axi verify\n  quiz-axi stop\n  quiz-axi setup hooks\n  quiz-axi server\n\nNote: poll long-polls indefinitely by default until the human acts, staying silent while it waits - never kill it. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. ${pollExecutionGuidance({ agent })}\n\n`;
}

function createCommandHelp({ agent = "generic" } = {}) {
  return {
    review: `Usage: quiz-axi review --quiz <quiz.json> [--base <ref>] [--no-open]\n       quiz-axi review --self-authored [--summary "..."] [--base <ref>]\n\nOpen a review session for the current diff (working tree vs. the resolved base branch: --base, QUIZ_AXI_BASE_BRANCH, @{upstream}, origin/HEAD, origin/main, or main, in that order). Untracked files are excluded - \`git add\` any new files first, or they will not appear in the reviewed diff and will not match what a later push sends. quiz.json describes questions about the diff; there is no answer key field, grading is always live via \`quiz-axi grade\`.\n\n--self-authored seals the diff as passed immediately with no quiz, no browser, no agent - meant for a human sealing a change they personally wrote. Agents should not run this themselves to skip a review.\n`,
    poll: `Usage: quiz-axi poll <diff_key> [--agent-reply "..."]\n\nLong-polls indefinitely for a human answer, question, or session end. Stays silent while waiting - never kill it. ${pollExecutionGuidance({ agent })} Use --agent-reply to display your response before waiting again.\n`,
    grade: `Usage: quiz-axi grade <diff_key> --question <id> --verdict correct|incorrect [--feedback "..."]\n       quiz-axi grade <diff_key> --finish pass|fail [--summary "..."]\n\nRecords a live verdict for one answered question, or seals the review record that \`quiz-axi verify\` checks.\n`,
    end: `Usage: quiz-axi end <diff_key>\n\nEnd a review session as the agent.\n`,
    verify: `Usage: quiz-axi verify [--to <sha>] [--base <ref>]\n\nThe husky pre-push gate. Reads the pre-push stdin protocol (or --to <sha> for a manual check of one commit, or defaults to the current working-tree diff) and checks the review record for each diff directly off disk - no server required. Every diff (review-time and push-time) is computed the same way: mergeBase(resolved base branch, commit) vs. commit, so re-pushing an already-reviewed branch with one more commit re-diffs against the same base 'review' used, not the remote's previous tip. Exits non-zero if any diff hasn't been reviewed and passed.\n`,
    stop: `Usage: quiz-axi stop [--port <port>]\n\nShut down the background quiz-axi server. It also stops itself when idle (QUIZ_AXI_IDLE_TIMEOUT_MS, default 30m) or immediately once the last session ends with nothing connected.\n`,
    setup: `Usage: quiz-axi setup hooks\n\nInstall agent SessionStart hooks (ambient context) for Claude Code, Codex, and OpenCode. Unrelated to the git hooks in .husky/.\n`,
    server: `Usage: quiz-axi server [--port 4388] [--verbose]\n\nRun the local quiz-axi server. QUIZ_AXI_HOST sets the bind address (default 127.0.0.1). QUIZ_AXI_NO_OPEN=1 suppresses the local browser launch.\n`,
  };
}
