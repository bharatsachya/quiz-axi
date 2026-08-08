// Coalescing for the queued-prompt submit path: at most one POST in flight, with a single
// "do it again when this one lands" flag rather than a growing chain. Sending twice quickly
// (or hitting Send while a slow request is still going) must not race two POSTs against the
// same queue, since each one splices what it sent back out of the shared array.
//
// Extracted from chrome-client.js because it is the trickiest untested logic in the file, and
// it becomes fully deterministic once `submitOnce` is injected. Browser-side ES module, also
// imported by node:test. No DOM or network access here - both live in the injected callback.

/**
 * @param {object} options
 * @param {() => Promise<unknown>} options.submitOnce Performs one actual submit.
 * @param {(outcome: { succeeded: boolean, shouldSubmitAgain: boolean, resubmit: () => Promise<unknown> }) => void} options.onSettled
 *   Runs after every attempt, in a `finally`. `succeeded` is false when `submitOnce` threw.
 *   `shouldSubmitAgain` is true when a submit was requested while this one was in flight; the
 *   caller decides whether that means calling `resubmit` (still work queued), doing something
 *   else (queue drained but an end was pending), or nothing.
 * @returns {() => Promise<unknown>} the coalesced submit
 */
export function createSubmitCoalescer({ submitOnce, onSettled }) {
  let inFlight = null;
  let again = false;

  async function submit() {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    let succeeded = false;
    inFlight = submitOnce();
    try {
      const result = await inFlight;
      succeeded = true;
      return result;
    } finally {
      // Cleared before onSettled runs, so a resubmit from inside the callback starts a fresh
      // attempt instead of coalescing into the one that just finished.
      inFlight = null;
      const shouldSubmitAgain = again;
      again = false;
      onSettled({ succeeded, shouldSubmitAgain, resubmit: submit });
    }
  }

  return submit;
}
