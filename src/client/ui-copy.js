// User-facing copy and small predicates, kept out of the DOM layer so the wording is
// reviewable and testable in one place - the same reason cli.js keeps its create*Output
// builders pure. Browser-side ES module, also imported by node:test.

// What the ended overlay says. Returns data, never touches the DOM: the caller applies
// `className` (null means neither outcome class) and the two strings.
export function endedOutcomeCopy(outcome) {
  if (outcome === "passed") {
    return {
      className: "outcome-passed",
      title: "All correct! Review passed.",
      copy: "This diff is now clear to push. You can close this tab and return to your terminal.",
    };
  }
  if (outcome === "failed") {
    return {
      className: "outcome-failed",
      title: "Review marked failed.",
      copy: "See your agent's notes in the conversation panel, or in your terminal. You can close this tab.",
    };
  }
  return {
    className: null,
    title: "Session ended.",
    copy: "Return to your agent to continue.",
  };
}

// Whether a keyboard event landed in something the human is typing into - arrow keys must
// move the caret there, not the guided tour.
export function isTypingTarget(el) {
  const tag = el && el.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || Boolean(el && el.isContentEditable);
}
