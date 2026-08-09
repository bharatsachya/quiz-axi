import assert from "node:assert/strict";
import test from "node:test";

import { createSubmitCoalescer } from "../src/client/submit-queue.js";

// A submitOnce whose completion the test controls, so the in-flight window is a real window
// rather than something a timer has to guess at.
function deferredSubmitter() {
  const calls = [];
  const submitOnce = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({ resolve, reject });
    return promise;
  };
  return { submitOnce, calls };
}

test("a submit while none is in flight runs immediately", async () => {
  const { submitOnce, calls } = deferredSubmitter();
  const settled = [];
  const submit = createSubmitCoalescer({ submitOnce, onSettled: (outcome) => settled.push(outcome) });

  const inFlight = submit();
  assert.equal(calls.length, 1);
  calls[0].resolve("ok");
  assert.equal(await inFlight, "ok");
  assert.equal(settled.length, 1);
  assert.deepEqual({ succeeded: settled[0].succeeded, again: settled[0].shouldSubmitAgain }, { succeeded: true, again: false });
});

test("submits during an in-flight request coalesce into ONE re-run, not one per call", async () => {
  const { submitOnce, calls } = deferredSubmitter();
  const settled = [];
  const submit = createSubmitCoalescer({
    submitOnce,
    onSettled: (outcome) => {
      settled.push(outcome);
      if (outcome.shouldSubmitAgain) outcome.resubmit();
    },
  });

  const first = submit();
  // Three more while the first is still open - all three must fold into a single re-run.
  submit();
  submit();
  submit();
  assert.equal(calls.length, 1, "no second request while one is in flight");

  calls[0].resolve("first");
  await first;
  assert.equal(calls.length, 2, "exactly one re-run, not three");

  calls[1].resolve("second");
  await Promise.resolve();
  assert.equal(settled.length, 2);
  assert.equal(settled[1].shouldSubmitAgain, false, "the re-run itself has nothing queued behind it");
});

test("callers waiting during a flight receive the in-flight promise, not a new one", async () => {
  const { submitOnce, calls } = deferredSubmitter();
  const submit = createSubmitCoalescer({ submitOnce, onSettled: () => {} });

  const first = submit();
  const second = submit();
  calls[0].resolve("shared");
  assert.equal(await first, "shared");
  assert.equal(await second, "shared");
});

test("a failed submit reports succeeded:false and still clears the in-flight slot", async () => {
  const { submitOnce, calls } = deferredSubmitter();
  const settled = [];
  const submit = createSubmitCoalescer({ submitOnce, onSettled: (outcome) => settled.push(outcome) });

  const first = submit();
  calls[0].reject(new Error("network down"));
  await assert.rejects(first, /network down/);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].succeeded, false);

  // Not wedged: the next submit starts a fresh request rather than returning the dead one.
  submit();
  assert.equal(calls.length, 2);
});

// The bug this guards: clearing inFlight AFTER onSettled would make a resubmit from inside the
// callback coalesce into the attempt that just finished, so the retry would never be sent.
test("a resubmit from inside onSettled starts a real new request", async () => {
  const { submitOnce, calls } = deferredSubmitter();
  let resubmitted = false;
  const submit = createSubmitCoalescer({
    submitOnce,
    onSettled: (outcome) => {
      if (resubmitted) return;
      resubmitted = true;
      outcome.resubmit();
    },
  });

  const first = submit();
  calls[0].resolve("one");
  await first;
  assert.equal(calls.length, 2, "the callback's resubmit must not fold into the finished attempt");
});
