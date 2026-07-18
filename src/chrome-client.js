/* global EventSource, document, window, CSS */

const sessionDataElement = document.getElementById("quiz-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const queueStorageKey = "quiz-axi:queued:" + key;

const panelScroll = document.getElementById("panelScroll");
const chatLog = document.getElementById("chatLog");
const annotationPills = document.getElementById("annotationPills");
const chatInput = document.getElementById("chatInput");
const sendButton = document.getElementById("send");
const sendAndEndButton = document.getElementById("sendAndEnd");
const moreWrap = document.getElementById("moreWrap");
const moreButton = document.getElementById("moreButton");
const moreMenu = document.getElementById("moreMenu");
const copyDiffButton = document.getElementById("copyDiff");
const endButton = document.getElementById("end");
const presenceBanner = document.getElementById("presenceBanner");
const sendHint = document.getElementById("sendHint");
const endedOverlay = document.getElementById("endedOverlay");
const endedCard = document.getElementById("endedCard");
const endedTitle = document.getElementById("endedTitle");
const endedCopy = document.getElementById("endedCopy");
const scoreReadout = document.getElementById("scoreReadout");
const diffView = document.getElementById("diffView");
const diffRawEl = document.getElementById("diff-raw");

const queued = loadQueuedPrompts();
let ended = false;
let agentPresence = "waiting";
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let endAfterSubmit = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

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

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function render() {
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued question" data-index="' +
        index +
        '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div></div>',
    )
    .join("");
  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
}

function updateSendState() {
  sendButton.disabled = ended || agentPresence === "working";
  sendAndEndButton.disabled = sendButton.disabled;
}

function showSendHint() {
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
  chatInput.focus();
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function setMenuOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

function addChat(role, text, shouldScroll = true) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }
  let lastChatBubble = null;
  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false) || lastChatBubble;
  if (workingBubble) {
    chatLog.appendChild(workingBubble);
    scrollElementIntoView(workingBubble);
  } else if (lastChatBubble) {
    scrollElementIntoView(lastChatBubble);
  }
}

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "working" ? state : "waiting";
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";
  if (agentPresence !== "working") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }
  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
  }
  scrollElementIntoView(workingBubble);
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function sendQueued(endAfter) {
  if (ended || agentPresence === "working") return;
  closeMenus();
  const text = chatInput.value.trim();
  if (text) {
    queued.push({ uid: "", prompt: text, selector: "", tag: "message", text: "Question for the agent" });
    persistQueuedPrompts();
    addChat("user", text);
    chatInput.value = "";
    render();
  }
  if (!queued.length) {
    showSendHint();
    return;
  }
  hideSendHint();
  if (endAfter) endAfterSubmit = true;
  submitQueued();
}

async function submitQueued() {
  if (submitQueuedPromise) {
    submitQueuedAgain = true;
    return submitQueuedPromise;
  }
  let succeeded = false;
  submitQueuedPromise = submitQueuedOnce();
  try {
    const result = await submitQueuedPromise;
    succeeded = true;
    return result;
  } finally {
    submitQueuedPromise = null;
    const shouldSubmitAgain = submitQueuedAgain;
    submitQueuedAgain = false;
    if (!succeeded) {
      endAfterSubmit = false;
    } else if (!ended && shouldSubmitAgain) {
      if (queued.length) {
        submitQueued();
      } else if (endAfterSubmit) {
        endAfterSubmit = false;
        endSession();
      }
    }
  }
}

async function submitQueuedOnce() {
  const prompts = queued.slice();
  const shouldEndSession = endAfterSubmit;
  const body = { prompts };
  if (shouldEndSession) body.endSession = true;
  const response = await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("failed to submit queued prompts");
  for (const prompt of prompts) {
    const index = queued.indexOf(prompt);
    if (index !== -1) queued.splice(index, 1);
  }
  persistQueuedPrompts();
  render();
  if (shouldEndSession) {
    endAfterSubmit = false;
    markSessionEnded();
    return;
  }
  if (agentPresence === "listening") setAgentPresence("working");
}

async function endSession() {
  if (ended) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded({ outcome } = {}) {
  if (ended) return;
  ended = true;
  closeMenus();
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = true;
  applyEndedMessage(outcome);
  endedOverlay.hidden = false;
  attemptAutoClose(outcome);
}

function applyEndedMessage(outcome) {
  if (!endedTitle || !endedCopy || !endedCard) return;
  endedCard.classList.remove("outcome-passed", "outcome-failed");
  if (outcome === "passed") {
    endedCard.classList.add("outcome-passed");
    endedTitle.textContent = "All correct! Review passed.";
    endedCopy.textContent = "This diff is now clear to push. You can close this tab and return to your terminal.";
  } else if (outcome === "failed") {
    endedCard.classList.add("outcome-failed");
    endedTitle.textContent = "Review marked failed.";
    endedCopy.textContent = "See your agent's notes in the conversation panel, or in your terminal. You can close this tab.";
  } else {
    endedTitle.textContent = "Session ended.";
    endedCopy.textContent = "Return to your agent to continue.";
  }
}

function attemptAutoClose(outcome) {
  if (outcome !== "passed") return;
  // Browsers only allow script-initiated close on tabs opened by script; a tab opened via the
  // OS `open` command (how `quiz-axi review` launches the browser) usually is NOT one of
  // those, so this best-effort attempt silently no-ops in most browsers - the visible message
  // above (and "you can close this tab") is the real fallback, not this call.
  setTimeout(() => {
    try {
      window.close();
    } catch {
      // ignored - the ended overlay's message is the fallback
    }
  }, 1200);
}

function copyDiffText() {
  closeMenus();
  copyText(diffRawEl ? diffRawEl.textContent || "" : "");
}

function lockCard(card) {
  for (const el of card.querySelectorAll("input, textarea, button.question-submit")) {
    el.disabled = true;
  }
}

function unlockCard(card) {
  for (const el of card.querySelectorAll("input, textarea, button.question-submit")) {
    el.disabled = false;
  }
}

function setCardBadge(card, kind, text) {
  const badge = card.querySelector(".question-badge");
  if (!badge) return;
  badge.hidden = false;
  badge.className = "question-badge" + (kind ? " " + kind : "");
  badge.textContent = text;
}

function submitAnswer(card) {
  const questionId = card.dataset.questionId || "";
  const questionType = card.dataset.questionType;
  let target;
  let promptText;
  if (questionType === "multiple-choice") {
    const checked = /** @type {HTMLInputElement | null} */ (card.querySelector('input[type="radio"]:checked'));
    if (!checked) {
      setCardBadge(card, "hint", "Select an answer first.");
      return;
    }
    const label = checked.closest(".choice")?.querySelector("span")?.textContent || checked.value;
    target = { type: "quiz-answer", question_id: questionId, choice_id: checked.value };
    promptText = "Answered: " + label;
  } else {
    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector(".question-freetext"));
    const value = textarea ? textarea.value.trim() : "";
    if (!value) {
      setCardBadge(card, "hint", "Write an answer first.");
      return;
    }
    target = { type: "quiz-answer", question_id: questionId, value };
    promptText = "Answered: " + value;
  }
  const submitBtn = /** @type {HTMLButtonElement} */ (card.querySelector(".question-submit"));
  submitBtn.disabled = true;
  fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompts: [{ uid: "", prompt: promptText, selector: "", tag: "quiz-answer", text: "Quiz answer", target }],
    }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("failed to submit answer");
      lockCard(card);
      setCardBadge(card, "pending", "Submitted · awaiting grading");
      if (agentPresence === "listening") setAgentPresence("working");
    })
    .catch(() => {
      submitBtn.disabled = false;
      setCardBadge(card, "hint", "Could not submit - try again.");
    });
}

function applyGradeSync(payload) {
  if (payload && payload.score && scoreReadout) {
    scoreReadout.textContent = "Score: " + payload.score.correct + "/" + payload.score.total;
  }
  if (payload && payload.question_id) {
    const selector = '.question-card[data-question-id="' + CSS.escape(payload.question_id) + '"]';
    const card = diffView.querySelector(selector);
    if (card) {
      if (payload.verdict === "correct") {
        lockCard(card);
        setCardBadge(card, "correct", "Correct");
      } else {
        // Re-enable so the human can retry - see the agent's feedback in the chat panel first.
        unlockCard(card);
        setCardBadge(card, "incorrect", "Not quite - see feedback below, then try again");
      }
    }
  }
}

diffView.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const button = target.closest(".question-submit");
  if (!button) return;
  const card = button.closest(".question-card");
  if (card) submitAnswer(card);
});

function jumpToHunk(hunkId) {
  const hunkEl = document.getElementById(hunkId);
  if (!hunkEl) return;
  hunkEl.scrollIntoView({ block: "center", behavior: "smooth" });
  hunkEl.classList.add("hunk-highlight");
  setTimeout(() => hunkEl.classList.remove("hunk-highlight"), 1600);
}

document.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const link = target.closest("[data-hunk-target]");
  if (link) jumpToHunk(link.dataset.hunkTarget);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = /** @type {HTMLElement} */ (event.target);
  const link = target.closest("[data-hunk-target]");
  if (!link) return;
  event.preventDefault();
  jumpToHunk(link.dataset.hunkTarget);
});

moreButton.onclick = () => toggleMenu(moreButton, moreMenu);
copyDiffButton.onclick = copyDiffText;
endButton.onclick = () => {
  closeMenus();
  endSession();
};
sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", hideSendHint);
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

render();
initialChat.forEach((item) => addChat(item.role, item.text));
setAgentPresence("waiting");

const events = new EventSource("/events/" + key);
events.addEventListener("agent-reply", (event) => addChat("agent", JSON.parse(event.data).text));
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));
events.addEventListener("grade-sync", (event) => applyGradeSync(JSON.parse(event.data)));
events.addEventListener("ended", (event) => markSessionEnded(JSON.parse(event.data)));
