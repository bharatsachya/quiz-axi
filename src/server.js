import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

import express from "express";

import { bindHost, hostForUrl, linkHost } from "./paths.js";
import { collectUngroundedAnchors } from "./quiz.js";
import { SessionStore } from "./session-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);

// Browser-side ES modules under src/client/, imported by chrome-client.js and served at the
// same relative paths so one specifier ("./client/tour.js") resolves identically in Node and
// in the browser. Adding a module means adding its name here.
export const CLIENT_MODULES = ["anchor.js", "text.js", "theme.js", "threads.js", "tour.js", "ui-copy.js", "submit-queue.js"];

// The single source of truth for where the reader's theme choice is remembered. Read in two
// places that cannot import from each other - the inline <head> bootstrap, which is a string
// interpolated into the HTML, and client/theme.js, which receives it through the session JSON.
// Written as one constant precisely so those two can never disagree.
const THEME_STORAGE_KEY = "quiz-axi:theme";

// Runs synchronously in <head>, BEFORE the stylesheet, on purpose: reading localStorage after
// the first paint means a dark-mode reader gets a white flash on every single page load.
const THEME_BOOTSTRAP = `<script>(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();</script>`;

const THEME_TOGGLE = `<button class="theme-toggle" data-theme-toggle type="button" title="Switch between light and dark" aria-label="Switch between light and dark"><span class="theme-icon theme-icon-light" aria-hidden="true">☀</span><span class="theme-icon theme-icon-dark" aria-hidden="true">☾</span></button>`;

// An explicit allowlist, never a path built from the request. `readFile(new URL(req.params.x,
// dirUrl))` would happily walk out of src/ with a ../ and serve anything readable.
export const STATIC_ASSETS = new Map([
  ["/chrome.css", [chromeCssUrl, "text/css"]],
  ["/chrome-client.js", [chromeClientUrl, "application/javascript"]],
  ...CLIENT_MODULES.map((name) => [`/client/${name}`, [new URL(`./client/${name}`, import.meta.url), "application/javascript"]]),
]);

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

// A detached server should not live forever. When no browser chrome (SSE) and no agent poll
// are connected for this long, the server shuts itself down. The next `quiz-axi review`
// re-spawns a fresh server and adopts resumable sessions from state.json. Set
// QUIZ_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.QUIZ_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return value;
}

export async function serve({
  port,
  stateFile,
  version = "",
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(),
  linkHost: linkHostName = linkHost(),
}) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const sseClients = new Set();
  const verbose = debug || process.env.QUIZ_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[quiz-axi] ${line}`) : null;
  let publicPort = port;

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "quiz-axi", version });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    setImmediate(shutdown);
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const key = String(req.body.key || "");
      if (!key) {
        res.status(400).json({ error: "key is required" });
        return;
      }
      const url = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      const session = await store.upsertSession(key, {
        repoRoot: String(req.body.repo_root || ""),
        url,
        diffText: String(req.body.diff_text || ""),
        diffStat: req.body.diff_stat || { files_changed: 0, insertions: 0, deletions: 0 },
        quiz: req.body.quiz || { version: 1, diff_summary: "", questions: [] },
      });
      if (session.status !== "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key}`);
      res.json({ key, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/poll", async (req, res, next) => {
    try {
      const key = String(req.query.key || "");
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (immediate.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
        res.json(immediate);
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      setPollActive(key, activePolls, deliveredFeedback, events, true);
      refreshIdleTimer();
      const timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, deliveredFeedback, events, false);
        refreshIdleTimer();
      };
      const respond = async () => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const result = await store.takeFeedback(key);
          if (result.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
          if (streamHeartbeat) {
            res.end(JSON.stringify(result));
          } else {
            res.json(result);
          }
        } finally {
          cleanup();
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) {
          return;
        }
        respond().catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      // Anchors are verified HERE, before the store sees them, so the store stays a dumb
      // persistence layer and never has to know how a diff is parsed.
      const payload = await resolveIncomingAnchors(req.params.key, req.body || {});
      const session = await store.queuePrompts(req.params.key, payload);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit(shouldEndSession ? "ended" : "feedback", req.params.key);
      broadcastChat(req.params.key, session);
      res.json({ status: "queued", pending_prompts: session.pending_prompts, score: session.score });
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/grade", async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.finish) {
        const result = body.finish === "pass" ? "pass" : body.finish === "fail" ? "fail" : null;
        if (!result) {
          res.status(400).json({ error: 'finish must be "pass" or "fail"' });
          return;
        }
        const session = await store.finishGrading(req.params.key, { result, summary: String(body.summary || "") });
        if (!session) {
          res.status(404).json({ error: "session not found" });
          return;
        }
        broadcastChat(req.params.key, session);
        events.emit("grade-sync", req.params.key, { finished: result, score: session.score });
        res.json({ status: "ok", finished: result, score: session.score });
        return;
      }
      const questionId = String(body.question_id || body.questionId || "");
      const verdict = body.verdict === "correct" ? "correct" : body.verdict === "incorrect" ? "incorrect" : null;
      if (!questionId || !verdict) {
        res.status(400).json({ error: "question_id and verdict (correct|incorrect) are required" });
        return;
      }
      const { session, autoFinished } = await store.gradeQuestion(req.params.key, {
        questionId,
        verdict,
        feedback: String(body.feedback || ""),
      });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      broadcastChat(req.params.key, session);
      events.emit("grade-sync", req.params.key, { question_id: questionId, verdict, score: session.score });
      if (autoFinished) {
        clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
        events.emit("ended", req.params.key, { ended_by: "agent", outcome: "passed" });
      }
      res.json({ status: "ok", question_id: questionId, verdict, score: session.score, auto_finished: autoFinished });
      if (autoFinished) await shutdownIfNoLiveSessions();
    } catch (error) {
      if (error?.code === "VALIDATION_ERROR") {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const threadId = req.body?.thread_id === undefined ? undefined : String(req.body.thread_id || "");
      const result = await store.addAgentReply(req.params.key, text, { threadId });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      broadcastChat(req.params.key, result.session);
      res.json({ status: "sent", thread_id: result.thread_id, ...(result.unknown_thread ? { unknown_thread: true } : {}) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key, "user");
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key, { ended_by: "user", outcome: await reviewOutcome(store, req.params.key) });
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const key = String(req.body.key || "");
      await store.endSession(key, "agent");
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key, { ended_by: "agent", outcome: await reviewOutcome(store, key) });
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      res.type("html").send(createChromeHtml(session, { title: "Quiz Review" }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      refreshIdleTimer();
      const session = await store.findByKey(req.params.key);
      // One event, one render path. An agent reply used to be broadcast on its own with no
      // indication of what it answered, which is precisely how a reply lands under the wrong
      // question; now every chat mutation re-sends the whole log and the client rebuilds from
      // it, so "attached to the wrong bubble" is not a state that can exist.
      const sendChatSync = (key, payload) => {
        if (key === req.params.key) {
          res.write(`event: chat-sync\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      };
      const sendPresence = (key, state) => {
        if (key === req.params.key) {
          res.write(`event: agent-presence\ndata: ${JSON.stringify({ state })}\n\n`);
        }
      };
      const sendGradeSync = (key, payload) => {
        if (key === req.params.key) {
          res.write(`event: grade-sync\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      };
      const sendEnded = (key, payload) => {
        if (key === req.params.key) {
          res.write(`event: ended\ndata: ${JSON.stringify(payload || {})}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [], threads: session?.threads || {} })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      if (session?.status === "ended") {
        res.write(`event: ended\ndata: ${JSON.stringify({ ended_by: session.ended_by, outcome: await reviewOutcome(store, req.params.key) })}\n\n`);
      }
      events.on("chat-sync", sendChatSync);
      events.on("agent-presence", sendPresence);
      events.on("grade-sync", sendGradeSync);
      events.on("ended", sendEnded);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("chat-sync", sendChatSync);
        events.off("agent-presence", sendPresence);
        events.off("grade-sync", sendGradeSync);
        events.off("ended", sendEnded);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  for (const [route, [assetUrl, contentType]] of STATIC_ASSETS) {
    app.get(route, async (req, res, next) => {
      try {
        res.type(contentType).send(await readFile(assetUrl, "utf8"));
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((error, req, res, _next) => {
    const status = Number(error?.statusCode || error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => {
      if (s.address()) resolve(s);
    });
    s.once("error", reject);
  });
  publicPort = httpServer.address().port;

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    httpServer.close(() => shutdownResolve());
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
  }

  let idleTimer = null;
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && sseClients.size === 0 && activePolls.size === 0) {
        logEvent?.(`idle for ${idleTimeoutMs}ms with no connections, shutting down`);
        shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // Re-sends the whole conversation after any mutation. Cheap (a review's chat is tens of
  // entries) and it makes the browser's view a pure function of what is on disk.
  function broadcastChat(key, session) {
    if (!session) return;
    events.emit("chat-sync", key, { chat: session.chat || [], threads: session.threads || {} });
  }

  // Rewrites each prompt's anchor to what the server can actually verify. Runs before the
  // store, and never rejects: an anchor that no longer resolves comes back flagged `stale`
  // rather than dropped, so the question still reaches the agent with its quote.
  async function resolveIncomingAnchors(key, body) {
    const prompts = Array.isArray(body.prompts) ? body.prompts : [];
    if (!prompts.some((prompt) => prompt?.target?.anchor)) return body;
    const session = await store.findByKey(key);
    if (!session) return body;
    const files = parseDiffForDisplay(session.diff_text);
    assignHunkDomIds(files);
    const blocks = collectAnchorBlocks(session.quiz, files);
    return {
      ...body,
      prompts: prompts.map((prompt) => {
        if (!prompt?.target?.anchor) return prompt;
        return { ...prompt, target: { ...prompt.target, anchor: resolveAnchor(prompt.target.anchor, { blocks, files }) } };
      }),
    };
  }

  async function shutdownIfNoLiveSessions() {
    if (sseClients.size > 0 || activePolls.size > 0) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        logEvent?.("last open session ended with no live connections, shutting down");
        setImmediate(shutdown);
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  refreshIdleTimer();

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

function setPollActive(key, activePolls, deliveredFeedback, events, active) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
    deliveredFeedback.delete(key);
  }
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (activePolls.has(key)) return "listening";
  if (deliveredFeedback.has(key)) return "working";
  return "waiting";
}

// Whatever review_index says right now, so any path to "ended" (auto-finish, or the agent's
// explicit finish+end) reports a consistent outcome to the browser's `ended` SSE event.
async function reviewOutcome(store, key) {
  const record = await store.findReviewIndex(key);
  if (record?.status === "passed") return "passed";
  if (record?.status === "failed") return "failed";
  return undefined;
}

const MORE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';

// Diff text has no `diff --git` header before the first hunk if the input is empty/malformed;
// callers only ever pass server-computed diff text, so that's the only defensive case here.
// Tracks old-side AND new-side line numbers per line (not just the new side) so the split
// (side-by-side) view below can show a correct gutter number on both columns.
function parseDiffForDisplay(diffText) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let oldLineNo = 0;
  let newLineNo = 0;
  const fileHeaderRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkHeaderRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of String(diffText || "").split("\n")) {
    const fileMatch = fileHeaderRe.exec(line);
    if (fileMatch) {
      currentFile = { file: fileMatch[2], hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }
    if (!currentFile) continue;
    const hunkMatch = hunkHeaderRe.exec(line);
    if (hunkMatch) {
      oldLineNo = Number(hunkMatch[1]);
      const newStart = Number(hunkMatch[2]);
      const newCount = hunkMatch[3] !== undefined ? Number(hunkMatch[3]) : 1;
      newLineNo = newStart;
      currentHunk = {
        header: line,
        startLine: newStart,
        endLine: newCount > 0 ? newStart + newCount - 1 : newStart,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", text: line.slice(1), oldLineNo: null, newLineNo });
      newLineNo += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", text: line.slice(1), oldLineNo, newLineNo: null });
      oldLineNo += 1;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "ctx", text: line.slice(1), oldLineNo, newLineNo });
      oldLineNo += 1;
      newLineNo += 1;
    }
  }
  return files;
}

// Pairs up a hunk's flat line list into left(old)/right(new) rows for a GitHub-style split
// view: context lines show the same content on both sides; a run of deletions immediately
// followed by a run of additions (the common "changed these lines" shape) pairs up
// positionally, left over lines on the longer side get an empty cell on the other side.
function buildSplitRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "ctx") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const dels = [];
    while (i < lines.length && lines[i].type === "del") {
      dels.push(lines[i]);
      i += 1;
    }
    const adds = [];
    while (i < lines.length && lines[i].type === "add") {
      adds.push(lines[i]);
      i += 1;
    }
    const max = Math.max(dels.length, adds.length);
    for (let j = 0; j < max; j += 1) {
      rows.push({ left: dels[j] || null, right: adds[j] || null });
    }
  }
  return rows;
}

function renderSplitCell(line, side) {
  if (!line) {
    return `<div class="split-cell split-${side} split-empty"></div>`;
  }
  const cls = line.type === "add" ? "split-add" : line.type === "del" ? "split-del" : "split-ctx";
  const lineNo = side === "left" ? line.oldLineNo : line.newLineNo;
  // data-side/data-ln let a selection in the diff be turned into a line range by attribute
  // lookup. The alternative - reading the gutter out of textContent - is exactly the mistake
  // that makes character offsets meaningless in a split view, since the number and the code
  // share one text flow.
  const anchorAttrs = lineNo === null || lineNo === undefined ? "" : ` data-side="${side === "left" ? "old" : "new"}" data-ln="${lineNo}"`;
  return `<div class="split-cell split-${side} ${cls}"${anchorAttrs}><span class="split-ln">${lineNo ?? ""}</span><span class="split-code">${escapeHtml(line.text)}</span></div>`;
}

function renderSplitRow(row) {
  return renderSplitCell(row.left, "left") + renderSplitCell(row.right, "right");
}

// Finds the real hunk (from server.js's own diff parse) that an anchor overlaps, the same
// "never trust the agent's own line numbers" check already used to place question cards.
// Walkthrough steps and decisions are display-only (never graded), so this is done fresh at
// render time instead of threading an extra anchor_matched field through quiz.js.
function findMatchingHunk(anchor, files) {
  if (!anchor) return null;
  const fileEntry = files.find((entry) => entry.file === anchor.file);
  if (!fileEntry) return null;
  return fileEntry.hunks.find((hunk) => anchor.start_line <= hunk.endLine && anchor.end_line >= hunk.startLine) || null;
}

/**
 * Verify an anchor the browser sent against the page the server would actually render.
 *
 * Same principle as findMatchingHunk and matchHunkAnchors: the client's own numbers are never
 * trusted. For a diff anchor the quoted text is REBUILT from the server's diff parse, so
 * whatever the browser claimed the lines say is discarded outright.
 *
 * Nothing is rejected. An anchor that no longer resolves is marked `stale` and downgraded, so
 * the human's question still reaches the agent with its quote attached - losing the question
 * because the prose moved would be a far worse outcome than pointing a little imprecisely.
 */
export function resolveAnchor(anchor, { blocks, files }) {
  if (!anchor || typeof anchor !== "object") return null;
  if (anchor.kind === "diff") return resolveDiffAnchor(anchor, files);

  const block = blocks.find((entry) => entry.id === anchor.block_id);
  // The block is gone entirely - a re-review whose new quiz.json dropped this step. Keep the
  // quote so the thread still reads, but there is nothing left to scroll to.
  if (!block) return { ...anchor, stale: true };
  if (anchor.kind === "block") return { ...anchor, block_kind: block.kind, exact: block.text, stale: false };

  const exact = String(anchor.exact || "");
  if (block.text.slice(anchor.start, anchor.end) === exact) {
    return { ...anchor, block_kind: block.kind, stale: false };
  }
  const at = block.text.indexOf(exact);
  if (exact && at !== -1) {
    return { ...anchor, block_kind: block.kind, start: at, end: at + exact.length, stale: false };
  }
  // The quote itself no longer appears in this block: the prose was rewritten under it. Fall
  // back to the whole block, flagged, rather than pointing at text that now says something else.
  return { kind: "block", block_id: anchor.block_id, block_kind: block.kind, exact: block.text, stale: true };
}

function resolveDiffAnchor(anchor, files) {
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (hunk.domId !== anchor.hunk_dom_id) continue;
      // A hunk id paired with the wrong filename means the page the client anchored against is
      // not the page we would render now.
      if (anchor.file && anchor.file !== file.file) return { ...anchor, file: file.file, whole_hunk: true, stale: true };
      const side = anchor.side === "old" ? "old" : "new";
      const lines = hunk.lines.filter((line) => (side === "old" ? line.oldLineNo !== null : line.newLineNo !== null));
      const lineNo = (line) => (side === "old" ? line.oldLineNo : line.newLineNo);
      const wanted = anchor.whole_hunk
        ? lines
        : lines.filter((line) => lineNo(line) >= anchor.start_line && lineNo(line) <= anchor.end_line);
      const chosen = wanted.length ? wanted : lines;
      return {
        kind: "diff",
        hunk_dom_id: hunk.domId,
        file: file.file,
        side,
        start_line: chosen.length ? lineNo(chosen[0]) : 0,
        end_line: chosen.length ? lineNo(chosen[chosen.length - 1]) : 0,
        whole_hunk: Boolean(anchor.whole_hunk) || wanted.length === 0,
        exact: chosen.map((line) => line.text).join("\n"),
        stale: false,
      };
    }
  }
  return { ...anchor, stale: true };
}

function assignHunkDomIds(files) {
  let counter = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      hunk.domId = `hunk-${counter}`;
      counter += 1;
    }
  }
}

// Stable ids for every block of prose a reader can highlight and ask about, built from the
// same quiz spec the renderer draws from. ONE list, two consumers: the renderers below stamp
// these ids into the HTML, and resolveAnchor checks an incoming anchor against them. Deriving
// them twice is how the two would drift.
//
// Blocks are the INNERMOST prose containers, never the <li> wrappers: an <li>'s textContent
// includes the step number and the "Agent"/"Human" badge, which would land in every offset.
export function collectAnchorBlocks(quiz, files) {
  const blocks = [];
  const seen = new Set();
  const add = (id, kind, text) => {
    if (!text) return;
    let unique = id;
    let n = 2;
    while (seen.has(unique)) unique = `${id}-${n++}`;
    seen.add(unique);
    blocks.push({ id: unique, kind, text });
  };
  if (quiz?.diff_summary) add("blk-summary", "diff-summary", quiz.diff_summary);
  const explainer = quiz?.explainer;
  if (explainer?.eli5) add("blk-eli5", "eli5", explainer.eli5);
  if (explainer?.summary) add("blk-explainer-summary", "summary", explainer.summary);
  if (explainer?.background) add("blk-background", "background", explainer.background);
  for (const [index, step] of (explainer?.walkthrough || []).entries()) {
    add(`blk-step-${index}`, "walkthrough-step", step.text);
  }
  for (const decision of quiz?.decisions || []) {
    const slug = slugForAnchorId(decision.id);
    add(`blk-dec-${slug}-text`, "decision", decision.decision);
    add(`blk-dec-${slug}-why`, "decision-why", decision.why);
    if (decision.alternatives?.length) {
      add(`blk-dec-${slug}-alts`, "decision-alternatives", `Considered: ${decision.alternatives.join(", ")}`);
    }
  }
  for (const question of quiz?.questions || []) {
    add(`blk-q-${slugForAnchorId(question.id)}-prompt`, "question-prompt", question.prompt);
  }
  // Diff hunks are anchorable too, but they already carry hunk-N ids from assignHunkDomIds and
  // are matched by line range rather than by text, so they are not block-anchored.
  void files;
  return blocks;
}

function slugForAnchorId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
}

// A block id is only meaningful next to the text it was computed from, so the two travel
// together: the renderer looks the id up by the exact string it is about to print.
function anchorAttrsFor(blocks, kind, text) {
  const block = blocks?.find((entry) => entry.kind === kind && entry.text === text && !entry.used);
  if (!block) return "";
  block.used = true;
  return ` data-anchor-block="${escapeHtml(block.id)}" data-anchor-kind="${escapeHtml(block.kind)}"`;
}

function renderWalkthroughStep(step, index, files, blocks) {
  const hunk = findMatchingHunk(step.hunk_anchor, files);
  const linkAttrs = hunk ? ` data-hunk-target="${hunk.domId}" role="button" tabindex="0"` : "";
  const linkClass = hunk ? " walkthrough-step-linked" : "";
  const anchorAttrs = anchorAttrsFor(blocks, "walkthrough-step", step.text);
  return `<li class="walkthrough-step${linkClass}"${linkAttrs}><span class="walkthrough-index">${index + 1}</span><span class="walkthrough-text"${anchorAttrs}>${escapeHtml(step.text)}</span></li>`;
}

function renderDecisionItem(decision, files, blocks) {
  const hunk = findMatchingHunk(decision.hunk_anchor, files);
  const linkAttrs = hunk ? ` data-hunk-target="${hunk.domId}" role="button" tabindex="0"` : "";
  const linkClass = hunk ? " decision-item-linked" : "";
  const badgeClass = decision.who === "human" ? "decision-badge-human" : "decision-badge-agent";
  const badgeText = decision.who === "human" ? "Human" : "Agent";
  const altText = decision.alternatives?.length ? `Considered: ${decision.alternatives.join(", ")}` : "";
  const alternatives = altText
    ? `<div class="decision-alternatives"${anchorAttrsFor(blocks, "decision-alternatives", altText)}>${escapeHtml(altText)}</div>`
    : "";
  const why = decision.why
    ? `<div class="decision-why"${anchorAttrsFor(blocks, "decision-why", decision.why)}>${escapeHtml(decision.why)}</div>`
    : "";
  const textAttrs = anchorAttrsFor(blocks, "decision", decision.decision);
  return `<li class="decision-item${linkClass}"${linkAttrs}><span class="decision-badge ${badgeClass}">${badgeText}</span><div class="decision-body"><div class="decision-text"${textAttrs}>${escapeHtml(decision.decision)}</div>${why}${alternatives}</div></li>`;
}

// The counted half of the grounding check: says out loud how many of the explainer's claims
// point at code that isn't in this diff. Without it a step whose anchor matched nothing renders
// as ordinary unlinked prose, indistinguishable from a step that was grounded - the same
// ambiguity the uncovered-hunks tour stop closes from the other side (there, code nobody
// explained; here, an explanation with no code under it).
function renderGroundingNoticeHtml(quiz, files) {
  const ungrounded = collectUngroundedAnchors(quiz, files);
  if (!ungrounded.length) return "";
  const items = ungrounded
    .map((entry) => {
      const reason =
        entry.reason === "file-not-in-diff"
          ? "not in this diff at all"
          : `lines ${entry.start_line}-${entry.end_line} match no hunk`;
      return `<li><code>${escapeHtml(entry.file)}</code> - ${escapeHtml(reason)}<span class="grounding-claim">${escapeHtml(entry.label)}</span></li>`;
    })
    .join("");
  const count = ungrounded.length;
  return `<details class="grounding-notice"><summary>${count} claim${count === 1 ? "" : "s"} here point${count === 1 ? "s" : ""} at code that isn't in this diff</summary><ul class="grounding-list">${items}</ul></details>`;
}

// Renders the ladder above the split diff: eli5 (plainest, most prominent) first, then
// summary/background, then the story-order walkthrough, then decisions. Returns "" when the
// quiz carries neither `explainer` nor `decisions` (any v1 quiz.json, and any v2/v3 one that
// omits both), so a v1 review renders byte-identical to before this existed.
function renderExplainerHtml(quiz, files, blocks) {
  const explainer = quiz.explainer;
  const decisions = Array.isArray(quiz.decisions) ? quiz.decisions : [];
  const hasWalkthrough = Boolean(explainer?.walkthrough?.length);
  if (!explainer && decisions.length === 0) return "";

  let html = '<div class="explainer">';
  if (explainer?.eli5) {
    html += `<div class="explainer-eli5"><div class="explainer-label">Like I'm five</div><p${anchorAttrsFor(blocks, "eli5", explainer.eli5)}>${escapeHtml(explainer.eli5)}</p></div>`;
  }
  if (explainer?.summary) {
    html += `<p class="explainer-summary"${anchorAttrsFor(blocks, "summary", explainer.summary)}>${escapeHtml(explainer.summary)}</p>`;
  }
  if (explainer?.background) {
    html += `<div class="explainer-background"><div class="explainer-label">Background</div><p${anchorAttrsFor(blocks, "background", explainer.background)}>${escapeHtml(explainer.background)}</p></div>`;
  }
  if (hasWalkthrough) {
    html += `<ol class="explainer-walkthrough">${explainer.walkthrough.map((step, index) => renderWalkthroughStep(step, index, files, blocks)).join("")}</ol>`;
  }
  if (decisions.length) {
    html += `<details class="decisions-block" id="decisionsBlock"${decisions.length <= 3 ? " open" : ""}><summary>Decisions (${decisions.length})</summary><ul class="decisions-list">${decisions.map((decision) => renderDecisionItem(decision, files, blocks)).join("")}</ul></details>`;
  }
  html += "</div>";
  return html;
}

function decisionFieldData(decision, files) {
  const hunk = findMatchingHunk(decision.hunk_anchor, files);
  return {
    decision_id: decision.id,
    who: decision.who,
    text: decision.decision,
    why: decision.why || "",
    alternatives: Array.isArray(decision.alternatives) ? decision.alternatives : [],
    hunk_dom_id: hunk ? hunk.domId : null,
  };
}

// Hunks no walkthrough step's hunk_anchor matched - the "what did the explainer never
// mention" gap, surfaced as its own tour stop (direction 2a, change 2).
function computeUncoveredHunks(files, walkthrough) {
  const covered = new Set(walkthrough.map((step) => findMatchingHunk(step.hunk_anchor, files)?.domId).filter(Boolean));
  const uncovered = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (covered.has(hunk.domId)) continue;
      uncovered.push({
        hunk_dom_id: hunk.domId,
        file: file.file,
        header: hunk.header,
        adds: hunk.lines.filter((line) => line.type === "add").length,
        dels: hunk.lines.filter((line) => line.type === "del").length,
      });
    }
  }
  return uncovered;
}

// Builds the "guided tour" step sequence (walkthrough drives, code appears per step, one
// question-checkpoint at a time - direction 2a, "gated tour"): eli5/summary/background each
// get their own step, then every walkthrough step in order, with any question whose
// hunk_anchor matches that step's hunk immediately following it as a checkpoint (re-matched
// fresh against the real diff, same "never trust the agent's own line numbers" principle used
// everywhere else), then any remaining unmatched questions. Decisions become their own stops
// (one each up to 3, one grouped "Decisions (N)" stop beyond that), inserted immediately
// before the first checkpoint whose question prompt mentions the decision's id, or right after
// the last walkthrough step if nothing references it. A trailing "uncovered hunks" stop (hunks
// no walkthrough step ever anchored to) lands right before the final "grade" step, when any
// exist. Kept as plain step data, not HTML - descriptive text renders client-side via
// textContent; only the real question-card and diff-hunk DOM nodes get moved into it (they
// carry live grading/interactive state), so a v1 quiz.json with no explainer still gets a tour
// of just its checkpoints. Reading is never gated (any read-step, and the raw-diff escape
// hatch docked at the bottom of the rail, stay reachable at all times) - only ADVANCING past an
// unresolved checkpoint, or a not-yet-visited decision/uncovered stop, is blocked, enforced
// client-side. A checkpoint carries hint_step_index (the FINAL tour-sequence index of the
// walkthrough step it followed, remapped after decision/uncovered stops are spliced in) so the
// client can offer a "re-read that step" link without losing checkpoint progress.
function buildTourSteps(quiz, files) {
  const explainer = quiz.explainer;
  const walkthrough = explainer?.walkthrough || [];
  const questions = quiz.questions || [];
  const decisions = Array.isArray(quiz.decisions) ? quiz.decisions : [];

  const core = [];
  if (explainer?.eli5) core.push({ kind: "eli5", label: "ELI5", text: explainer.eli5 });
  if (explainer?.summary) core.push({ kind: "summary", label: "Summary", text: explainer.summary });
  if (explainer?.background) core.push({ kind: "background", label: "Background", text: explainer.background });

  const walkthroughHunkIds = walkthrough.map((step) => findMatchingHunk(step.hunk_anchor, files)?.domId || null);
  const questionsByStepIndex = new Map();
  const looseQuestions = [];
  for (const question of questions) {
    const hunk = question.anchor_matched ? findMatchingHunk(question.hunk_anchor, files) : null;
    const stepIndex = hunk ? walkthroughHunkIds.indexOf(hunk.domId) : -1;
    if (stepIndex >= 0) {
      const list = questionsByStepIndex.get(stepIndex) || [];
      list.push({ question, hunk });
      questionsByStepIndex.set(stepIndex, list);
    } else {
      looseQuestions.push({ question, hunk });
    }
  }

  let checkpointNumber = 0;
  let lastWalkthroughCoreIndex = -1;
  walkthrough.forEach((step, index) => {
    const walkthroughCoreIndex = core.length;
    lastWalkthroughCoreIndex = walkthroughCoreIndex;
    core.push({ kind: "walkthrough", label: `Step ${index + 1}`, text: step.text, hunk_dom_id: walkthroughHunkIds[index] });
    for (const { question, hunk } of questionsByStepIndex.get(index) || []) {
      checkpointNumber += 1;
      core.push({
        kind: "checkpoint",
        label: `Checkpoint ${checkpointNumber}`,
        question_id: question.id,
        hunk_dom_id: hunk ? hunk.domId : null,
        hint_step_index: walkthroughCoreIndex,
      });
    }
  });
  for (const { question, hunk } of looseQuestions) {
    checkpointNumber += 1;
    core.push({
      kind: "checkpoint",
      label: `Checkpoint ${checkpointNumber}`,
      question_id: question.id,
      hunk_dom_id: hunk ? hunk.domId : null,
    });
  }

  const questionsById = new Map(questions.map((question) => [question.id, question]));
  function firstReferencingCoreIndex(decisionId) {
    for (let i = 0; i < core.length; i += 1) {
      const step = core[i];
      if (step.kind !== "checkpoint") continue;
      const question = questionsById.get(step.question_id);
      if (question && typeof question.prompt === "string" && question.prompt.includes(decisionId)) return i;
    }
    return -1;
  }
  const fallbackAnchor = lastWalkthroughCoreIndex + 1;

  const inserts = [];
  if (decisions.length > 0 && decisions.length <= 3) {
    decisions.forEach((decision, index) => {
      const anchor = firstReferencingCoreIndex(decision.id);
      inserts.push({
        anchor: anchor >= 0 ? anchor : fallbackAnchor,
        step: {
          kind: "decision",
          label: `Decision ${decision.id}`,
          position: index + 1,
          total: decisions.length,
          ...decisionFieldData(decision, files),
        },
      });
    });
  } else if (decisions.length > 3) {
    let earliest = -1;
    for (const decision of decisions) {
      const anchor = firstReferencingCoreIndex(decision.id);
      if (anchor >= 0 && (earliest === -1 || anchor < earliest)) earliest = anchor;
    }
    inserts.push({
      anchor: earliest >= 0 ? earliest : fallbackAnchor,
      step: {
        kind: "decisions-group",
        label: `Decisions (${decisions.length})`,
        decisions: decisions.map((decision, index) => ({
          position: index + 1,
          total: decisions.length,
          ...decisionFieldData(decision, files),
        })),
      },
    });
  }

  // Only meaningful once a walkthrough actually exists - "not covered by an explainer that
  // was never written" isn't a real gap, it's just the no-explainer case handled elsewhere.
  const uncovered = walkthrough.length > 0 ? computeUncoveredHunks(files, walkthrough) : [];
  if (uncovered.length > 0) {
    inserts.push({ anchor: core.length, step: { kind: "uncovered", label: "Uncovered hunks", hunks: uncovered } });
  }

  const byAnchor = new Map();
  for (const { anchor, step } of inserts) {
    const list = byAnchor.get(anchor) || [];
    list.push(step);
    byAnchor.set(anchor, list);
  }
  const merged = [];
  const coreIndexRemap = [];
  for (let i = 0; i <= core.length; i += 1) {
    if (byAnchor.has(i)) merged.push(...byAnchor.get(i));
    if (i < core.length) {
      coreIndexRemap[i] = merged.length;
      merged.push(core[i]);
    }
  }
  for (const step of merged) {
    if (step.kind === "checkpoint" && typeof step.hint_step_index === "number") {
      step.hint_step_index = coreIndexRemap[step.hint_step_index];
    }
  }

  if (merged.length > 0) merged.push({ kind: "grade", label: "Grade" });
  return merged;
}

function renderQuestionCard(question, blocks) {
  const body =
    question.type === "multiple-choice"
      ? `<div class="question-choices">${question.choices
          .map(
            (choice) =>
              `<label class="choice"><input type="radio" name="q-${escapeHtml(question.id)}" value="${escapeHtml(choice.id)}"><span>${escapeHtml(choice.text)}</span></label>`,
          )
          .join("")}</div>`
      : `<textarea class="question-freetext" placeholder="Type your answer..."></textarea>`;
  return `<div class="question-card" data-question-id="${escapeHtml(question.id)}" data-question-type="${question.type}"><div class="question-prompt"${anchorAttrsFor(blocks, "question-prompt", question.prompt)}>${escapeHtml(question.prompt)}</div>${body}<div class="question-actions"><button class="button question-submit" type="button">Submit Answer</button><span class="question-badge" hidden></span></div></div>`;
}

function renderDiffHtml(files, questions, blocks) {
  if (files.length === 0) {
    return '<p class="diff-empty">No diff content.</p>';
  }
  const anchoredByFile = new Map();
  for (const question of questions) {
    if (question.anchor_matched && question.hunk_anchor) {
      const list = anchoredByFile.get(question.hunk_anchor.file) || [];
      list.push(question);
      anchoredByFile.set(question.hunk_anchor.file, list);
    }
  }
  let html = "";
  for (const file of files) {
    html += `<div class="diff-file"><div class="diff-file-header">${escapeHtml(file.file)}</div>`;
    const fileQuestions = anchoredByFile.get(file.file) || [];
    const placed = new Set();
    for (const hunk of file.hunks) {
      const rows = buildSplitRows(hunk.lines);
      html += `<details class="diff-hunk-details" id="${hunk.domId}" open><summary class="diff-hunk-summary">${escapeHtml(hunk.header)}</summary><div class="diff-hunk-split">${rows.map(renderSplitRow).join("")}</div></details>`;
      const matched = fileQuestions.filter(
        (question) =>
          !placed.has(question.id) &&
          question.hunk_anchor.start_line <= hunk.endLine &&
          question.hunk_anchor.end_line >= hunk.startLine,
      );
      for (const question of matched) {
        placed.add(question.id);
        html += renderQuestionCard(question, blocks);
      }
    }
    html += `</div>`;
  }
  const unanchored = questions.filter((question) => !question.anchor_matched);
  if (unanchored.length) {
    html += `<div class="questions-section"><h3>Questions</h3>${unanchored.map((question) => renderQuestionCard(question, blocks)).join("")}</div>`;
  }
  return html;
}

export function createChromeHtml(session, { title = "Quiz Review" } = {}) {
  const files = parseDiffForDisplay(session.diff_text);
  assignHunkDomIds(files);
  const questions = session.quiz.questions || [];
  const blocks = collectAnchorBlocks(session.quiz, files);
  const diffHtml = renderDiffHtml(files, questions, blocks);
  const explainerHtml = renderExplainerHtml(session.quiz, files, blocks);
  const tour = buildTourSteps(session.quiz, files);
  const sessionJson = jsonScript({
    key: session.key,
    initialChat: session.chat || [],
    initialThreads: session.threads || {},
    tour,
    themeStorageKey: THEME_STORAGE_KEY,
  });
  const stat = session.diff_stat || { files_changed: 0, insertions: 0, deletions: 0 };
  const score = session.score || { answered: 0, correct: 0, total: 0 };
  const summary = session.quiz.diff_summary ? `<p class="diff-summary">${escapeHtml(session.quiz.diff_summary)}</p>` : "";
  // The guided tour only makes sense when there's at least one step (an explainer field or a
  // question); a trivial review with neither has nothing to walk through, so it goes straight
  // to (and stays on) full review mode with no toggle at all.
  const tourToggle = tour.length > 0 ? `<button class="tour-toggle" id="tourToggle" type="button">Guided tour</button>` : "";
  const significanceChip = session.quiz.significance
    ? `<span class="chip-mini">${escapeHtml(session.quiz.significance)}</span>`
    : "";
  const tourShell =
    tour.length > 0
      ? `<div class="tour-mode" id="tourMode"><div class="tour-bar">${significanceChip}<div class="tour-progress-track"><div class="tour-progress-fill" id="tourProgressFill"></div></div><span class="tour-count" id="tourCount"></span></div><div class="tour-layout"><nav class="tour-rail" id="tourRail"></nav><div class="tour-main"><div class="tour-kicker-row" id="tourKickerRow" hidden><span class="tour-kicker" id="tourKicker"></span><span class="decision-badge" id="tourKickerBadge" hidden></span></div><div class="tour-step-label" id="tourStepLabel"></div><div class="tour-step-text" id="tourStepText"></div><div class="tour-decision-fields" id="tourDecisionFields"></div><div class="tour-excerpt-slot" id="tourExcerptSlot"></div><p class="tour-excerpt-caption" id="tourExcerptCaption" hidden>only the hunk this step anchors to - nothing else</p><div class="tour-multi-list" id="tourMultiList"></div><div class="tour-card-slot" id="tourCardSlot"></div><p class="tour-checkpoint-caption" id="tourCheckpointCaption" hidden>Answer correctly to continue - reading is never blocked, only advancing.</p><button class="tour-hint-link" id="tourHintLink" type="button" hidden></button><div class="tour-nav"><button class="button-plain" id="tourBack" type="button">&#9664; back</button><button class="button-plain" id="tourNext" type="button">next &#9654;</button></div></div></div></div>`
      : "";
  // fullReview wraps the diff+explainer+questions as one unit so the tour can hide/reveal it
  // as a whole; it starts hidden whenever a tour exists (the tour is the default landing
  // view), and is the only thing rendered at all when there's no tour to show.
  const fullReview = `<div class="diff-meta">${summary}<p class="diff-stat">${stat.files_changed} file(s) changed, +${stat.insertions} -${stat.deletions}</p></div>${explainerHtml}<div class="diff-view" id="diffView">${diffHtml}</div>`;
  // Sits outside the fullReview/tour toggle, not inside the explainer block: it is a caveat
  // about the whole artifact, and the tour (the default landing view) hides fullReview
  // entirely - a trust signal only visible in the mode the reader didn't pick isn't one.
  const groundingHtml = renderGroundingNoticeHtml(session.quiz, files);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${THEME_BOOTSTRAP}
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="quiz">
<div class="bar"><div class="brand"><span class="brand-mark">Quiz</span><span class="brand-support">AXI</span></div><div class="spacer" aria-hidden="true"></div>${tourToggle}${THEME_TOGGLE}<div class="score-readout" id="scoreReadout">Score: ${score.correct}/${score.total}</div><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${MORE_ICON}</button><div class="menu more-menu" id="moreMenu" hidden><button class="menu-item" id="copyDiff" type="button">Copy diff</button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">End session</button></div></div></div>
<div class="layout"><div class="frame">${groundingHtml}<div id="fullReview"${tour.length > 0 ? " hidden" : ""}>${fullReview}</div>${tourShell}</div><aside class="panel"><h2>Conversation</h2><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div><div class="composer"><div class="ask-chip" id="askChip" hidden><span class="ask-chip-label">About</span><span class="ask-chip-text" id="askChipText"></span><button class="ask-chip-clear" id="askChipClear" type="button" aria-label="Clear the passage this question is about">×</button></div><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from quiz-axi.</div><textarea id="chatInput" placeholder="Ask a question about this change..."></textarea><div class="send-hint" id="sendHint" hidden>Write a question first.</div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">Send &amp; End</button><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<button class="ask-button" id="askButton" type="button" hidden>Ask about this</button>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card" id="endedCard"><div class="ended-title" id="endedTitle">Session ended.</div><p class="ended-copy" id="endedCopy">Return to your agent to continue.</p></div></div>
<script id="quiz-session" type="application/json">${sessionJson}</script>
<script id="diff-raw" type="text/plain">${escapeHtml(session.diff_text || "")}</script>
<script type="module" src="/chrome-client.js"></script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .split("\u2028")
    .join("\\u2028")
    .split("\u2029")
    .join("\\u2029");
}
