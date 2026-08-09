// Grouping the flat chat log into threads for display.
//
// `session.chat` stays a FLAT array on disk - entries simply gained an optional `thread_id`.
// That is what lets a chat array written before threads existed render exactly as it always
// did: no ids, so no grouping, so N bubbles in order. There is no migration step anywhere,
// and `upsertSession`'s promise to preserve an existing chat array survives untouched.
//
// Browser-side ES module, also imported by node:test. No DOM access here - this returns a
// display plan and the caller builds nodes from it.

/**
 * Turn (chat, threads) into an ordered list of items to render.
 *
 * Loose entries stay exactly where they fall. A thread appears once, at the position of its
 * FIRST turn, and collects every later turn - so a thread the human returns to an hour later
 * doesn't jump to the bottom of the panel and lose its place in the conversation.
 *
 * @returns {Array<{ type: "message", entry: object } | { type: "thread", thread: object, turns: object[] }>}
 */
export function buildChatView(chat, threads = {}) {
  const items = [];
  const indexByThread = new Map();
  for (const entry of Array.isArray(chat) ? chat : []) {
    const threadId = entry?.thread_id;
    if (!threadId) {
      items.push({ type: "message", entry });
      continue;
    }
    const existing = indexByThread.get(threadId);
    if (existing !== undefined) {
      items[existing].turns.push(entry);
      continue;
    }
    indexByThread.set(threadId, items.length);
    items.push({
      type: "thread",
      // A thread_id with no matching sidecar record still renders - as a thread with no quoted
      // passage. Dropping the turns instead would silently lose the human's own words.
      thread: threads?.[threadId] || { id: threadId },
      turns: [entry],
    });
  }
  return items;
}

/** Every turn of one thread, in order. What the agent is handed so a bare "why?" is complete. */
export function threadTurns(chat, threadId) {
  return (Array.isArray(chat) ? chat : [])
    .filter((entry) => entry?.thread_id === threadId)
    .map((entry) => ({ role: entry.role, text: entry.text, at: entry.at }));
}

// crypto.randomUUID is undefined outside a secure context. 127.0.0.1 counts as one, but
// QUIZ_AXI_HOST can bind a LAN address, and there an unguarded call would throw and take the
// whole send path down with it - questions would silently stop sending.
export function newThreadId(crypto = globalThis.crypto, now = Date.now, random = Math.random) {
  const uuid = crypto?.randomUUID?.();
  if (uuid) return `t-${uuid.slice(0, 12)}`;
  return `t-${now().toString(36)}${random().toString(36).slice(2, 8)}`;
}
