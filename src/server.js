import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

import express from "express";

import { bindHost, hostForUrl, linkHost } from "./paths.js";
import { SessionStore } from "./session-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);

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
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit(shouldEndSession ? "ended" : "feedback", req.params.key);
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
        if (body.summary) events.emit("agent-reply", req.params.key, String(body.summary));
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
      const session = await store.gradeQuestion(req.params.key, {
        questionId,
        verdict,
        feedback: String(body.feedback || ""),
      });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (body.feedback) events.emit("agent-reply", req.params.key, String(body.feedback));
      events.emit("grade-sync", req.params.key, { question_id: questionId, verdict, score: session.score });
      res.json({ status: "ok", question_id: questionId, verdict, score: session.score });
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
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key, "user");
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key);
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
      events.emit("ended", key);
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
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) {
          res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
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
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      events.on("agent-reply", sendAgentReply);
      events.on("agent-presence", sendPresence);
      events.on("grade-sync", sendGradeSync);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-presence", sendPresence);
        events.off("grade-sync", sendGradeSync);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

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

const MORE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';

// Diff text has no `diff --git` header before the first hunk if the input is empty/malformed;
// callers only ever pass server-computed diff text, so that's the only defensive case here.
function parseDiffForDisplay(diffText) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let newLineNo = 0;
  const fileHeaderRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
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
      const start = Number(hunkMatch[1]);
      const count = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      newLineNo = start;
      currentHunk = { header: line, startLine: start, endLine: count > 0 ? start + count - 1 : start, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", text: line.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", text: line.slice(1), lineNo: null });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "ctx", text: line.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    }
  }
  return files;
}

function renderDiffLine(line) {
  const cls = line.type === "add" ? "diff-line-add" : line.type === "del" ? "diff-line-del" : "diff-line-ctx";
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return `<span class="diff-line ${cls}">${marker}${escapeHtml(line.text)}</span>`;
}

function renderQuestionCard(question) {
  const body =
    question.type === "multiple-choice"
      ? `<div class="question-choices">${question.choices
          .map(
            (choice) =>
              `<label class="choice"><input type="radio" name="q-${escapeHtml(question.id)}" value="${escapeHtml(choice.id)}"><span>${escapeHtml(choice.text)}</span></label>`,
          )
          .join("")}</div>`
      : `<textarea class="question-freetext" placeholder="Type your answer..."></textarea>`;
  return `<div class="question-card" data-question-id="${escapeHtml(question.id)}" data-question-type="${question.type}"><div class="question-prompt">${escapeHtml(question.prompt)}</div>${body}<div class="question-actions"><button class="button question-submit" type="button">Submit Answer</button><span class="question-badge" hidden></span></div></div>`;
}

function renderDiffHtml(diffText, questions) {
  const files = parseDiffForDisplay(diffText);
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
      html += `<pre class="diff-hunk"><span class="diff-hunk-header">${escapeHtml(hunk.header)}</span>\n${hunk.lines
        .map(renderDiffLine)
        .join("\n")}</pre>`;
      const matched = fileQuestions.filter(
        (question) =>
          !placed.has(question.id) &&
          question.hunk_anchor.start_line <= hunk.endLine &&
          question.hunk_anchor.end_line >= hunk.startLine,
      );
      for (const question of matched) {
        placed.add(question.id);
        html += renderQuestionCard(question);
      }
    }
    html += `</div>`;
  }
  const unanchored = questions.filter((question) => !question.anchor_matched);
  if (unanchored.length) {
    html += `<div class="questions-section"><h3>Questions</h3>${unanchored.map(renderQuestionCard).join("")}</div>`;
  }
  return html;
}

export function createChromeHtml(session, { title = "Quiz Review" } = {}) {
  const sessionJson = jsonScript({
    key: session.key,
    initialChat: session.chat || [],
  });
  const diffHtml = renderDiffHtml(session.diff_text, session.quiz.questions || []);
  const stat = session.diff_stat || { files_changed: 0, insertions: 0, deletions: 0 };
  const score = session.score || { answered: 0, correct: 0, total: 0 };
  const summary = session.quiz.diff_summary ? `<p class="diff-summary">${escapeHtml(session.quiz.diff_summary)}</p>` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="quiz">
<div class="bar"><div class="brand"><span class="brand-mark">Quiz</span><span class="brand-support">AXI</span></div><div class="spacer" aria-hidden="true"></div><div class="score-readout" id="scoreReadout">Score: ${score.correct}/${score.total}</div><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${MORE_ICON}</button><div class="menu more-menu" id="moreMenu" hidden><button class="menu-item" id="copyDiff" type="button">Copy diff</button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">End session</button></div></div></div>
<div class="layout"><div class="frame"><div class="diff-meta">${summary}<p class="diff-stat">${stat.files_changed} file(s) changed, +${stat.insertions} -${stat.deletions}</p></div><div class="diff-view" id="diffView">${diffHtml}</div></div><aside class="panel"><h2>Conversation</h2><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div><div class="composer"><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from quiz-axi.</div><textarea id="chatInput" placeholder="Ask a question about this change..."></textarea><div class="send-hint" id="sendHint" hidden>Write a question first.</div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">Send &amp; End</button><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div></div></div>
<script id="quiz-session" type="application/json">${sessionJson}</script>
<script id="diff-raw" type="text/plain">${escapeHtml(session.diff_text || "")}</script>
<script src="/chrome-client.js"></script>
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
