import assert from "node:assert/strict";
import test from "node:test";

import { endedOutcomeCopy, isTypingTarget } from "../src/client/ui-copy.js";
import { escapeHtml } from "../src/client/text.js";

test("ended copy: a pass says the diff is clear to push", () => {
  const copy = endedOutcomeCopy("passed");
  assert.equal(copy.className, "outcome-passed");
  assert.match(copy.title, /passed/i);
  assert.match(copy.copy, /clear to push/);
});

test("ended copy: a fail points at the agent's notes and never claims a pass", () => {
  const copy = endedOutcomeCopy("failed");
  assert.equal(copy.className, "outcome-failed");
  assert.match(copy.title, /failed/i);
  assert.doesNotMatch(copy.copy, /clear to push/);
});

// Anything that isn't a sealed outcome - undefined, null, "ended", a future status - must fall
// through to the neutral wording rather than implying a verdict that was never reached.
test("ended copy: an unknown outcome falls back to neutral wording with no outcome class", () => {
  for (const outcome of [undefined, null, "", "ended", "abandoned"]) {
    const copy = endedOutcomeCopy(outcome);
    assert.equal(copy.className, null, `outcome ${JSON.stringify(outcome)} should carry no outcome class`);
    assert.equal(copy.title, "Session ended.");
  }
});

test("isTypingTarget: true for text entry, false for everything else", () => {
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "DIV" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("escapeHtml escapes every character that could break out of markup", () => {
  assert.equal(escapeHtml('<script>alert("x") & \'y\'</script>'), "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(null), "null");
});
