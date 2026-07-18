/* global EventSource, document, window, CSS */

const sessionDataElement = document.getElementById("quiz-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const tourSpecs = Array.isArray(sessionData.tour) ? sessionData.tour : [];
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
const tourToggle = document.getElementById("tourToggle");
const tourMode = document.getElementById("tourMode");
const fullReview = document.getElementById("fullReview");
const tourProgressFill = document.getElementById("tourProgressFill");
const tourCount = document.getElementById("tourCount");
const tourRail = document.getElementById("tourRail");
const tourKickerRow = document.getElementById("tourKickerRow");
const tourKicker = document.getElementById("tourKicker");
const tourKickerBadge = document.getElementById("tourKickerBadge");
const tourStepLabel = document.getElementById("tourStepLabel");
const tourStepText = document.getElementById("tourStepText");
const tourDecisionFields = document.getElementById("tourDecisionFields");
const tourExcerptSlot = document.getElementById("tourExcerptSlot");
const tourExcerptCaption = document.getElementById("tourExcerptCaption");
const tourMultiList = document.getElementById("tourMultiList");
const tourCardSlot = document.getElementById("tourCardSlot");
const tourCheckpointCaption = document.getElementById("tourCheckpointCaption");
const tourHintLink = document.getElementById("tourHintLink");
const tourBack = document.getElementById("tourBack");
const tourNext = document.getElementById("tourNext");

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
    // A global lookup, not diffView.querySelector: the guided tour moves the real card node
    // into its own slot outside #diffView, so it must still be found there.
    const selector = '.question-card[data-question-id="' + CSS.escape(payload.question_id) + '"]';
    const card = document.querySelector(selector);
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
    setTourVerdict(payload.question_id, payload.verdict);
  }
}

document.addEventListener("click", (event) => {
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

// Guided tour: the walkthrough drives, code appears per step. It does not re-render
// questions or code - it MOVES the real .question-card and .diff-hunk-split nodes already
// rendered in full review mode into its own slots, so submitting/grading/retry behavior is
// exactly the same code path either way. Nodes return to their original position whenever a
// step changes or the tour is exited, so full review mode (still rendered underneath, just
// hidden) is always left intact.
function resolveHunkRef(domId) {
  const el = domId ? document.getElementById(domId) : null;
  return { el, home: el ? { parent: el.parentNode, next: el.nextSibling } : null };
}

const tourSteps = tourSpecs.map((spec) => {
  const hunkEl = spec.hunk_dom_id ? document.getElementById(spec.hunk_dom_id) : null;
  const cardEl =
    spec.kind === "checkpoint"
      ? document.querySelector('.question-card[data-question-id="' + CSS.escape(spec.question_id) + '"]')
      : null;
  let multiHunks = null;
  if (spec.kind === "decisions-group") {
    multiHunks = spec.decisions.map((decision) => resolveHunkRef(decision.hunk_dom_id));
  } else if (spec.kind === "uncovered") {
    multiHunks = spec.hunks.map((hunk) => resolveHunkRef(hunk.hunk_dom_id));
  }
  return {
    ...spec,
    hunkEl,
    hunkHome: hunkEl ? { parent: hunkEl.parentNode, next: hunkEl.nextSibling } : null,
    cardEl,
    cardHome: cardEl ? { parent: cardEl.parentNode, next: cardEl.nextSibling } : null,
    multiHunks,
  };
});

let tourIndex = 0;
let tourActive = false;
const tourVerdictByQuestionId = {};
const tourVisitedIndices = new Set();

function returnNodeHome(el, home) {
  if (!el || !home) return;
  if (home.next && home.next.parentNode === home.parent) {
    home.parent.insertBefore(el, home.next);
  } else {
    home.parent.appendChild(el);
  }
}

function returnStepNodesHome(step) {
  if (!step) return;
  returnNodeHome(step.hunkEl, step.hunkHome);
  returnNodeHome(step.cardEl, step.cardHome);
  if (step.multiHunks) {
    for (const ref of step.multiHunks) returnNodeHome(ref.el, ref.home);
  }
}

function setTourVerdict(questionId, verdict) {
  tourVerdictByQuestionId[questionId] = verdict === "correct" ? "correct" : verdict === "incorrect" ? "incorrect" : null;
  if (tourSteps.length) refreshTourStepChrome();
}

const TOUR_MUST_VISIT_KINDS = new Set(["decision", "decisions-group", "uncovered"]);

// Reading is never gated - you can always look back at anything, and the raw-diff escape
// hatch docked at the bottom of the rail is always open. Only ADVANCING is gated: the first
// unresolved checkpoint (not yet graded correct) or not-yet-visited decision/uncovered stop is
// a hard wall nothing past it is reachable, computed fresh every time (never cached) so a
// grade arriving mid-browse immediately opens the path forward.
function maxReachableTourIndex() {
  for (let index = 0; index < tourSteps.length; index += 1) {
    const step = tourSteps[index];
    if (step.kind === "checkpoint" && tourVerdictByQuestionId[step.question_id] !== "correct") return index;
    if (TOUR_MUST_VISIT_KINDS.has(step.kind) && !tourVisitedIndices.has(index)) return index;
  }
  return tourSteps.length - 1;
}

function tourRailIcon(step, index, maxReachable) {
  if (index > maxReachable) return "🔒";
  if (step.kind === "checkpoint") {
    const verdict = tourVerdictByQuestionId[step.question_id];
    if (verdict === "correct") return "✓";
    if (verdict === "incorrect") return "✕";
    return "◇";
  }
  if (step.kind === "uncovered") return "▨";
  if (TOUR_MUST_VISIT_KINDS.has(step.kind)) return "◈";
  if (index === tourIndex) return "▸";
  if (index < tourIndex) return "✓";
  return step.kind === "grade" ? "⚑" : "";
}

function tourRailKindClass(step) {
  return TOUR_MUST_VISIT_KINDS.has(step.kind) ? " tour-rail-decision" : "";
}

function renderTourRail() {
  if (!tourRail) return;
  tourRail.innerHTML = "";
  const maxReachable = maxReachableTourIndex();
  tourSteps.forEach((step, index) => {
    const locked = index > maxReachable;
    const item = document.createElement("button");
    item.type = "button";
    item.disabled = locked;
    item.className =
      "tour-rail-item" +
      tourRailKindClass(step) +
      (locked ? " tour-rail-locked" : index === tourIndex ? " tour-rail-current" : index < tourIndex ? " tour-rail-done" : "");
    const icon = document.createElement("span");
    icon.className = "tour-rail-icon";
    icon.textContent = tourRailIcon(step, index, maxReachable);
    const label = document.createElement("span");
    label.textContent = step.label;
    item.appendChild(icon);
    item.appendChild(label);
    if (!locked) item.addEventListener("click", () => showTourStep(index));
    tourRail.appendChild(item);
  });
  const diffLink = document.createElement("button");
  diffLink.type = "button";
  diffLink.className = "tour-rail-diff-link";
  diffLink.textContent = "Raw diff ↗";
  diffLink.addEventListener("click", () => exitTourMode());
  tourRail.appendChild(diffLink);
}

function decisionFieldRows(container, decision) {
  container.innerHTML = "";
  if (decision.why) {
    const row = document.createElement("p");
    const lead = document.createElement("strong");
    lead.textContent = "Why:";
    row.appendChild(lead);
    row.appendChild(document.createTextNode(" " + decision.why));
    container.appendChild(row);
  }
  if (decision.alternatives && decision.alternatives.length) {
    const row = document.createElement("p");
    const lead = document.createElement("strong");
    lead.textContent = "Rejected:";
    row.appendChild(lead);
    row.appendChild(document.createTextNode(" " + decision.alternatives.join(", ")));
    container.appendChild(row);
  }
}

function whoBadge(el, who) {
  el.className = "decision-badge " + (who === "human" ? "decision-badge-human" : "decision-badge-agent");
  el.textContent = who === "human" ? "Human" : "Agent";
}

function buildDecisionCard(decision, hunkRef) {
  const card = document.createElement("div");
  card.className = "tour-decision-card";
  const kickerRow = document.createElement("div");
  kickerRow.className = "tour-kicker-row";
  const kicker = document.createElement("span");
  kicker.className = "tour-kicker";
  kicker.textContent = "DECISION " + String(decision.decision_id).toUpperCase() + " · " + decision.position + " OF " + decision.total;
  const badge = document.createElement("span");
  whoBadge(badge, decision.who);
  kickerRow.appendChild(kicker);
  kickerRow.appendChild(badge);
  card.appendChild(kickerRow);
  const headline = document.createElement("div");
  headline.className = "tour-step-text";
  headline.textContent = decision.text;
  card.appendChild(headline);
  const fields = document.createElement("div");
  fields.className = "tour-decision-fields";
  decisionFieldRows(fields, decision);
  if (fields.childElementCount) card.appendChild(fields);
  if (hunkRef && hunkRef.el) {
    const slot = document.createElement("div");
    slot.className = "tour-excerpt-slot";
    slot.appendChild(hunkRef.el);
    card.appendChild(slot);
  }
  return card;
}

function renderStopBody(step) {
  const isSingleDecision = step.kind === "decision";
  const isGroup = step.kind === "decisions-group";
  const isUncovered = step.kind === "uncovered";

  tourKickerRow.hidden = !isSingleDecision;
  if (isSingleDecision) {
    tourKicker.textContent = "DECISION " + String(step.decision_id).toUpperCase() + " · " + step.position + " OF " + step.total;
    tourKickerBadge.hidden = false;
    whoBadge(tourKickerBadge, step.who);
  }

  tourStepLabel.hidden = isSingleDecision;
  tourDecisionFields.innerHTML = "";
  tourDecisionFields.hidden = !isSingleDecision;
  tourMultiList.innerHTML = "";
  tourMultiList.hidden = !(isGroup || isUncovered);
  tourExcerptSlot.innerHTML = "";
  tourCardSlot.innerHTML = "";

  if (step.kind === "grade") {
    tourStepText.hidden = false;
    tourStepText.textContent =
      "That's everything. Your agent grades checkpoints live and finishes the review once it's watched you get through them.";
  } else if (step.kind === "checkpoint") {
    tourStepText.hidden = true;
  } else if (isSingleDecision) {
    tourStepText.hidden = false;
    tourStepText.textContent = step.text || "";
    decisionFieldRows(tourDecisionFields, step);
  } else if (isGroup) {
    tourStepText.hidden = true;
    step.decisions.forEach((decision, index) => {
      tourMultiList.appendChild(buildDecisionCard(decision, step.multiHunks[index]));
    });
  } else if (isUncovered) {
    tourStepText.hidden = false;
    tourStepText.textContent = "These hunks aren't referenced by any walkthrough step.";
    step.hunks.forEach((hunkInfo, index) => {
      const hunkRef = step.multiHunks[index];
      const row = document.createElement("details");
      row.className = "tour-uncovered-row";
      const summary = document.createElement("summary");
      summary.textContent = hunkInfo.file + " · " + hunkInfo.header + " · +" + hunkInfo.adds + " -" + hunkInfo.dels;
      row.appendChild(summary);
      const slot = document.createElement("div");
      slot.className = "tour-excerpt-slot";
      row.appendChild(slot);
      row.addEventListener("toggle", () => {
        if (!hunkRef.el) return;
        if (row.open) slot.appendChild(hunkRef.el);
        else returnNodeHome(hunkRef.el, hunkRef.home);
      });
      tourMultiList.appendChild(row);
    });
    const footnote = document.createElement("p");
    footnote.className = "tour-uncovered-footnote";
    footnote.textContent = "Curious about one of these? Ask your agent in the conversation panel.";
    tourMultiList.appendChild(footnote);
  } else {
    tourStepText.hidden = false;
    tourStepText.textContent = step.text || "";
  }

  if (!isGroup && !isUncovered && step.hunkEl) {
    tourExcerptSlot.appendChild(step.hunkEl);
    tourExcerptCaption.hidden = false;
  } else {
    tourExcerptCaption.hidden = true;
  }
  if (step.cardEl) tourCardSlot.appendChild(step.cardEl);
}

function showTourStep(index) {
  if (!tourSteps.length) return;
  const maxReachable = maxReachableTourIndex();
  const bounded = Math.max(0, Math.min(index, tourSteps.length - 1, maxReachable));
  returnStepNodesHome(tourSteps[tourIndex]);
  tourIndex = bounded;
  tourVisitedIndices.add(tourIndex);
  const step = tourSteps[tourIndex];
  tourStepLabel.textContent = step.label;
  renderStopBody(step);
  if (step.kind === "checkpoint" && typeof step.hint_step_index === "number" && tourSteps[step.hint_step_index]) {
    const hintTarget = step.hint_step_index;
    tourHintLink.textContent = "hint: re-read " + tourSteps[hintTarget].label + " ▸";
    tourHintLink.onclick = () => showTourStep(hintTarget);
  } else {
    tourHintLink.onclick = null;
  }
  refreshTourStepChrome();
}

// Updates everything that depends on live grading state (nav button disabled-ness, the
// checkpoint caption, the hint link's visibility, the rail) without touching the excerpt/card
// slots - called both at the end of showTourStep and whenever a grade-sync arrives, so
// answering the current checkpoint correctly unlocks "next" immediately without re-moving the
// already-in-place hunk/card nodes (which could otherwise steal focus mid-interaction).
function refreshTourStepChrome() {
  const step = tourSteps[tourIndex];
  const maxReachable = maxReachableTourIndex();
  const isOpenCheckpoint = step.kind === "checkpoint" && tourVerdictByQuestionId[step.question_id] !== "correct";
  tourCheckpointCaption.hidden = !isOpenCheckpoint;
  tourHintLink.hidden = !(step.kind === "checkpoint" && typeof step.hint_step_index === "number");
  tourCount.textContent = tourIndex + 1 + " / " + tourSteps.length;
  tourProgressFill.style.width = Math.round(((tourIndex + 1) / tourSteps.length) * 100) + "%";
  tourBack.disabled = tourIndex === 0;
  tourNext.disabled = tourIndex >= Math.min(tourSteps.length - 1, maxReachable);
  tourNext.textContent = TOUR_MUST_VISIT_KINDS.has(step.kind) ? "understood ▶" : "next ▶";
  renderTourRail();
}

function enterTourMode() {
  tourActive = true;
  if (fullReview) fullReview.hidden = true;
  tourMode.hidden = false;
  showTourStep(tourIndex);
}

function exitTourMode() {
  returnStepNodesHome(tourSteps[tourIndex]);
  tourActive = false;
  tourMode.hidden = true;
  if (fullReview) fullReview.hidden = false;
}

function isTypingTarget(el) {
  const tag = el && el.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || (el && el.isContentEditable);
}

if (tourMode && tourSteps.length) {
  tourBack.addEventListener("click", () => showTourStep(tourIndex - 1));
  tourNext.addEventListener("click", () => showTourStep(tourIndex + 1));
  if (tourToggle) tourToggle.addEventListener("click", enterTourMode);
  document.addEventListener("keydown", (event) => {
    if (!tourActive || isTypingTarget(event.target)) return;
    if (event.key === "ArrowRight") showTourStep(tourIndex + 1);
    else if (event.key === "ArrowLeft") showTourStep(tourIndex - 1);
  });
  enterTourMode();
} else if (tourMode) {
  tourMode.hidden = true;
  if (fullReview) fullReview.hidden = false;
}

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
