---
name: quiz-axi
description: Brief the human on a code change with a layered explainer (plain-language analogy down to code) built from the decisions made during the session, then quiz them on it before it ships, using the quiz-axi CLI - a husky pre-push hook blocks `git push` until the diff has been reviewed and passed. Use after finishing any non-trivial or AI-generated change, before pushing. Also: while making any change in this repo, keep the decision journal described inside, as you work.
argument-hint: <optional: what to focus the review on>
metadata:
  hermes:
    tags: [code-review, git, quiz, understanding, push-gate]
    category: productivity
---

# quiz-axi

quiz-axi opens a review page for an AI agent's code diff that **teaches first, then checks**: a layered explainer the reader climbs by choice - *like I'm five* (plain-language analogy, zero background needed), then *the concepts*, then *the code, hunk by hunk* - plus the decisions that shaped the change, followed by a small quiz. A husky pre-push hook already wired in this repo's `.husky/pre-push` gates `git push` on passing it.

Two principles govern everything below. First: **the diff is a lossy record.** The real semantics of a change live in the decisions made while producing it - which alternative was rejected, what the human insisted on, what got reversed after a failure - so you capture those *as you work* and build the review from them, instead of reconstructing meaning from the final diff. Second: **anyone who actually read the explainer should pass the quiz easily.** The quiz exists only to catch skimming; if a question would be hard for an attentive reader of your explainer, the question is wrong.

There is no npm package for this yet - always invoke it as `node bin/quiz-axi.js <command>` from the repository root (this repo, `quiz-axi` itself).

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/quiz-axi` explicitly to focus the review on something specific - center the explainer and the questions on that.
If it is empty, infer what to review from the most recent change in this conversation.

## When to use

Use quiz-axi after finishing a code change the human should understand before it ships - especially anything non-trivial, anything you generated with significant judgment calls, or anything touching correctness/security-sensitive logic. Run it before the human tries to `git push`; the pre-push hook will block them anyway if you skip this, so doing it proactively avoids a confusing failed push.

## Keep a decision journal as you work

The explainer is only as good as its raw material, and the raw material is not the diff - it is the decisions. So this habit applies **while you are making changes, long before review time**: every fork in the road gets one entry in a scratch journal outside the repo (e.g. `/tmp/quiz-axi-journal.jsonc`, one file per task).

What counts as a fork: anything with a plausible alternative you did not take, anything you reversed after a failure, any real tradeoff, and **every constraint or call the human made** ("keep it simple", "no answer key", "reuse the existing client"). What does not: mechanical consequences of a decision already made (the renames that follow a rename).

An entry is small:

```jsonc
{
  "id": "d1",
  "who": "agent",              // or "human"
  "decision": "Identify reviews by a hash of the diff text, not the commit SHA",
  "alternatives": ["commit SHA", "branch name + timestamp"],   // what was actually considered
  "why": "SHAs change on rebase even when content didn't; the diff hash only changes when the change does",
  "hunk_anchor": { "file": "src/diff.js", "start_line": 12, "end_line": 19 }   // optional, add once the code exists
}
```

`who: "human"` entries matter as much as your own - at review time they show the reader their own fingerprints on the change, and weeks later they answer "why on earth did we do it this way?".

At review time, copy the entries that still matter into `quiz.json`'s `decisions` array and prune the noise. If you failed to journal during the session, reconstruct entries honestly from the conversation history - but live journaling is the rule; reconstruction is the fallback and always loses detail.

## Size the review first

Effort must be proportional to the change, or the human will (rightly) start bypassing the gate. Check `git diff --stat` against the base and pick a significance level:

| significance | when | explainer | questions |
| --- | --- | --- | --- |
| `trivial` | up to ~15 changed lines with no behavior change: docs, comments, formatting, renames, version bumps | summary only | 0 - seal `pass` right away |
| `small` | one focused change, up to ~50 lines | eli5 + summary + short walkthrough | 1 |
| `normal` | a typical feature or fix | full ladder + decisions | 2-3 |
| `high` | security/correctness-critical logic, concurrency, subtle judgment calls, or the user asked to focus on something | full ladder + decisions | 3-5 |

The whole review - reading plus answering - should take about 90 seconds at `normal`. If it would take longer, cut questions before cutting explainer clarity. Never quiz a human on a typo fix. And the inverse check: if a "trivial" change involved a genuine decision, it is not trivial - bump it to `small`.

## Write the explainer (this is the important part)

The explainer is the product; the quiz is just the receipt. Write it like catching a colleague up over coffee, not like documentation. It is a ladder the reader climbs by choice - each rung assumes a little more background - with four parts, all inside `quiz.json`:

- **`eli5`** - the top rung: explain the change so someone with *zero* background understands it. An everyday analogy plus behavior words ("when you refresh, it used to forget your choice - now it can't"). 2-4 sentences, one idea per sentence. **Forbidden in this field: file names, function names, class names, and jargon of any kind.** This rung is also your own comprehension check: if you cannot write it, you do not yet understand your own change - stop and understand it first. A change that resists a simple explanation is often a change that should itself be simpler. For the rare change that is irreducibly technical, still describe what someone will *notice* behaving differently, in behavior words.
- **`summary`** - 1-3 plain sentences for practitioners: what changed and why. No filler openers ("This PR introduces...").
- **`background`** - the ONE concept that already existed before this change that the reader needs in order to follow it (how the middleware chain works, why the cache has two layers, what an isometric projection is). 2-4 sentences, taught, not name-dropped. Omit the field entirely if the change truly needs no background - never pad.
- **`walkthrough`** - the literate diff: an ordered list of steps that walk the hunks in *story order* (the order that makes sense to a reader), never file/alphabetical order. Each step is 1-2 sentences of prose plus a `hunk_anchor` pointing at the lines it explains. Only cover hunks that carry meaning; fold mechanical noise into one step ("plus the matching renames across three files").

## Write questions that aren't punishment

Draw questions from three sources, in order of value:

1. **Decisions** - "why X instead of Y?", with the rejected alternatives from the journal as the wrong choices. These are the best questions available: the distractors are maximally plausible because they were genuinely considered, and they test *why*, not *what*.
2. **Consequences** - "what happens now that didn't happen before?" - answerable from the `eli5` and `summary` alone.
3. **Mechanics** - hunk-anchored questions about how the code does it. Use these only at `high` significance.

At least one question in every review must be passable by someone who read *only* the `eli5` rung - that is what keeps the zero-background promise honest.

Rules, in priority order:

1. **Answerable from the explainer plus the shown diff alone.** The quiz verifies they read; it is not archaeology and not a memory test.
2. **Ask about consequences and reasons, never raw values.** Bad: "What did the timeout change to?" Good: "A request now takes 35 seconds - what happens that didn't happen before?"
3. **Wrong choices must be plausible misconceptions** - what a skimmer would believe, or an alternative that was genuinely considered - never obvious throwaways.
4. **Nothing answerable from the PR title alone**, and nothing a language model could answer as general knowledge without this specific change in front of it. Tie every question to this diff.
5. **Free-text sparingly**, only when the answer is one short sentence; grade on meaning, generously.

## quiz.json (version 3)

Write it **outside this repository** (e.g. `/tmp/quiz.json`, or your scratchpad directory) - inside the repo it would get swept into the very diff it describes (same reason untracked files are excluded from the diff).

```jsonc
{
  "version": 3,
  "significance": "normal",          // trivial | small | normal | high
  "explainer": {
    "eli5": "Zero-background analogy in behavior words. No file names, no function names, no jargon.",  // required except at trivial
    "summary": "One to three sentences on what changed and why.",
    "background": "Optional: the one pre-existing concept the reader needs.",  // omit if none
    "walkthrough": [
      {
        "text": "One or two sentences explaining this part of the change.",
        "hunk_anchor": { "file": "path/relative/to/repo", "start_line": 10, "end_line": 18 }
      }
    ]
  },
  "decisions": [                     // pruned from your journal; who is "agent" or "human"
    {
      "id": "d1",
      "who": "agent",
      "decision": "Identify reviews by a hash of the diff text, not the commit SHA",
      "alternatives": ["commit SHA", "branch name + timestamp"],
      "why": "SHAs change on rebase even when content didn't; the diff hash only changes when the change does",
      "hunk_anchor": { "file": "src/diff.js", "start_line": 12, "end_line": 19 }  // optional
    }
  ],
  "questions": [                     // [] is valid when significance is "trivial"
    {
      "id": "q1",
      "type": "multiple-choice",     // or "free-text"
      "prompt": "A request now takes 35 seconds - what happens that didn't happen before?",
      "choices": [{ "id": "a", "text": "..." }, { "id": "b", "text": "..." }],  // multiple-choice only
      "hunk_anchor": { "file": "path/relative/to/repo", "start_line": 10, "end_line": 18 }  // optional
    }
  ]
}
```

There is still no answer-key field: grading is always live, done by you, never auto-graded - even for an "obviously correct" multiple-choice pick.

## Workflow

1. `git add` any new files that are part of the change. This matters: quiz-axi's diff deliberately excludes untracked (never `git add`ed) files, so the reviewed diff always matches what a later `git push` actually sends. Anything you don't stage will silently not appear in the review.
2. Size the change (table above), then assemble `quiz.json` outside the repo from your decision journal: write the `eli5` rung first (it is your own comprehension check), then the rest of the explainer, then prune journal entries into `decisions`, then questions - decisions-sourced questions first.
3. Run `node bin/quiz-axi.js review --quiz <path-to-quiz.json> [--base <ref>]` to open a review session in the browser, and note the `diff_key` it prints - every later command needs it. `--base` picks the branch to diff against; it defaults to the current branch's upstream, then `origin/HEAD`/`origin/main`/`origin/master`, then local `main`/`master`.
4. For a `trivial` review: seal it immediately - `node bin/quiz-axi.js grade <diff_key> --finish pass --summary "trivial: <one line>"` - then `end`. No quiz, no poll loop. The summary still lands in the record the human can see.
5. Otherwise, do not respond to the user yet. Immediately run `node bin/quiz-axi.js poll <diff_key>`. This long-polls silently until the human answers, asks something, or ends the session - leave it running, never kill it.
   - Keep the poll in the foreground by default and let it return activity directly to you.
   - A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify you.
   - Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.
   - If the poll gets killed or times out anyway, just re-run it - queued activity is never lost.
6. When poll returns answered questions (`tag: "quiz-answer"`, see `prompts[].target.question_id`/`.choice_id`/`.value`), grade each one live and honestly:
   `node bin/quiz-axi.js grade <diff_key> --question <id> --verdict correct|incorrect [--feedback "..."]`
   **A wrong answer is a teaching moment, not a failure.** Grade it `incorrect` with feedback that points back to the exact explainer step or hunk that answers it, and let the human answer again. Then poll again.
7. When poll returns a free-text question back from the human (`tag: "message"`), reply on your next poll:
   `node bin/quiz-axi.js poll <diff_key> --agent-reply "<answer>"`
   These questions are gold - each one marks something the explainer failed to teach. If the same question could come up again, the answer belonged in the explainer.
8. Once every question has been answered correctly (after retries), finish:
   `node bin/quiz-axi.js grade <diff_key> --finish pass [--summary "..."]`
   Reserve `--finish fail` for a review the human abandons or clearly will not engage with - never for wrong first attempts. This is exactly the record `quiz-axi verify` (the pre-push hook) checks - `pass` clears the gate for this diff, `fail` leaves it blocked until re-reviewed. If it is a `fail`, explain the gap to the user in this conversation before ending the session.
9. Run `node bin/quiz-axi.js end <diff_key>` when the review is finished.
10. If you edit the code again after finishing (`pass` or `fail`), the diff has changed - the old review record no longer applies, and you must run `review` again before the human can push. This is intentional integrity, not a bug: don't try to work around it. On a re-review, carry the explainer and `decisions` over, update only what changed, add any new decisions from the follow-up work, and ask questions only about the *new* material - never re-quiz hunks the human already passed unless they changed again.

## Commands & rules

- `node bin/quiz-axi.js review --quiz <quiz.json> [--base <ref>] [--no-open]` - open a review session for the current diff.
- `node bin/quiz-axi.js poll <diff_key> [--agent-reply "..."]` - long-poll for human activity; never pass `--timeout-ms` in normal use, it's a test/debug-only escape hatch.
- `node bin/quiz-axi.js grade <diff_key> --question <id> --verdict correct|incorrect [--feedback "..."]` - grade one answered question.
- `node bin/quiz-axi.js grade <diff_key> --finish pass|fail [--summary "..."]` - seal the review record `verify` checks.
- `node bin/quiz-axi.js end <diff_key>` - end a session as the agent.
- `node bin/quiz-axi.js verify` - what `.husky/pre-push` actually calls; it reads the review record straight off disk, no server needed. You generally never need to run this yourself - it's what blocks the human's `git push` if you skipped the workflow above.
- `node bin/quiz-axi.js stop` - shut down the background server (it also self-stops when idle or once the last session ends with nothing connected).
- `node bin/quiz-axi.js setup hooks` installs *agent* SessionStart hooks (ambient context at the start of a session) - unrelated to the *git* hooks in `.husky/` that gate `git push`. Both are called "hooks" but are different mechanisms.
- The reviewed diff is always computed the same way regardless of push history: `mergeBase(resolved base branch, commit)` vs. that commit. Re-pushing an already-reviewed branch with one more commit re-diffs the whole branch against the same base, not just what's new since the last push - so a small follow-up commit correctly requires re-review too (see step 10: on re-review, quiz only the new material).
- `node bin/quiz-axi.js review --self-authored [--summary "..."]` seals a diff as passed instantly, with no quiz, no browser, no poll loop. **You must never run this yourself to skip a review** - it exists for a human to type at their own keyboard when they personally wrote the change and there's nothing for you to explain. If you're tempted to reach for it because grading is taking effort or the human seems impatient, don't: that's exactly the review you're supposed to be running. The human can also bypass everything with `git push --no-verify` (git's own standard hook bypass) - that's their call to make, never yours to suggest as a shortcut.