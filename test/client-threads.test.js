import assert from "node:assert/strict";
import test from "node:test";

import { buildChatView, newThreadId, threadTurns } from "../src/client/threads.js";

// THE migration guarantee, asserted directly: a chat array written before threads existed has
// no thread_id anywhere, so it must render exactly as it always did - N bubbles, in order.
// There is no migration step, and this is what proves none is needed.
test("a legacy flat chat with no thread_id renders as N messages in order", () => {
  const chat = [
    { role: "user", text: "why?" },
    { role: "agent", text: "because" },
    { role: "user", text: "ok" },
  ];
  const view = buildChatView(chat, {});
  assert.equal(view.length, 3);
  assert.deepEqual(
    view.map((item) => item.type),
    ["message", "message", "message"],
  );
  assert.deepEqual(
    view.map((item) => item.entry.text),
    ["why?", "because", "ok"],
  );
});

test("turns of one thread collapse into a single item", () => {
  const chat = [
    { role: "user", text: "what does this block?", thread_id: "t-1" },
    { role: "agent", text: "pushes with no record", thread_id: "t-1" },
    { role: "user", text: "why?", thread_id: "t-1" },
  ];
  const view = buildChatView(chat, { "t-1": { id: "t-1", anchor: { exact: "the hook" } } });
  assert.equal(view.length, 1);
  assert.equal(view[0].type, "thread");
  assert.equal(view[0].turns.length, 3);
  assert.equal(view[0].thread.anchor.exact, "the hook");
});

// A thread stays where it started rather than jumping to the bottom when revisited - otherwise
// returning to an old question reorders the whole conversation under the reader.
test("a thread appears at its FIRST turn, even when later turns come after other messages", () => {
  const chat = [
    { role: "user", text: "q1", thread_id: "t-1" },
    { role: "user", text: "loose" },
    { role: "agent", text: "a1", thread_id: "t-1" },
  ];
  const view = buildChatView(chat, {});
  assert.deepEqual(
    view.map((item) => item.type),
    ["thread", "message"],
  );
  assert.equal(view[0].turns.length, 2);
  assert.equal(view[1].entry.text, "loose");
});

test("threads and loose messages interleave, each keeping its place", () => {
  const chat = [
    { role: "agent", text: "graded: not quite" },
    { role: "user", text: "about this bit", thread_id: "t-a" },
    { role: "user", text: "and this one", thread_id: "t-b" },
    { role: "agent", text: "answer a", thread_id: "t-a" },
  ];
  const view = buildChatView(chat, {});
  assert.deepEqual(
    view.map((item) => item.type),
    ["message", "thread", "thread"],
  );
  assert.equal(view[1].thread.id, "t-a");
  assert.equal(view[1].turns.length, 2);
  assert.equal(view[2].turns.length, 1);
});

// Dropping the turns instead would silently lose the human's own words.
test("a thread_id with no sidecar record still renders, just without a quote", () => {
  const view = buildChatView([{ role: "user", text: "orphan", thread_id: "t-gone" }], {});
  assert.equal(view.length, 1);
  assert.equal(view[0].thread.id, "t-gone");
  assert.equal(view[0].thread.anchor, undefined);
  assert.equal(view[0].turns[0].text, "orphan");
});

test("buildChatView tolerates missing or malformed input", () => {
  assert.deepEqual(buildChatView(undefined, undefined), []);
  assert.deepEqual(buildChatView(null, {}), []);
});

test("threadTurns returns just that thread's turns, in order", () => {
  const chat = [
    { role: "user", text: "a", at: "1", thread_id: "t-1" },
    { role: "user", text: "b", at: "2", thread_id: "t-2" },
    { role: "agent", text: "c", at: "3", thread_id: "t-1" },
  ];
  assert.deepEqual(threadTurns(chat, "t-1"), [
    { role: "user", text: "a", at: "1" },
    { role: "agent", text: "c", at: "3" },
  ]);
  assert.deepEqual(threadTurns(chat, "t-none"), []);
});

test("newThreadId uses randomUUID when it is available", () => {
  const id = newThreadId({ randomUUID: () => "abcdef01-2345-6789-abcd-ef0123456789" });
  assert.equal(id, "t-abcdef01-234");
});

// crypto.randomUUID is undefined outside a secure context, and QUIZ_AXI_HOST can bind a LAN
// address. An unguarded call there would throw and take the entire send path down with it.
test("newThreadId falls back when crypto.randomUUID is unavailable", () => {
  // null, not undefined: undefined would trigger the default parameter and reach the real
  // global crypto, testing nothing.
  for (const crypto of [null, {}, { randomUUID: () => undefined }]) {
    const id = newThreadId(crypto, () => 1717171717171, () => 0.123456789);
    assert.match(id, /^t-[a-z0-9]+$/);
  }
});

test("newThreadId produces distinct ids within the same millisecond", () => {
  let n = 0;
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) ids.add(newThreadId(null, () => 1717171717171, () => (n += 0.13)));
  assert.equal(ids.size, 5);
});
