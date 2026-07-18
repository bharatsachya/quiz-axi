---
name: quiz-axi
description: Quiz the human reviewer on a code change in this repo before it ships, using the quiz-axi CLI - then a husky pre-push hook blocks `git push` until the diff has been reviewed and passed. Use after finishing a non-trivial or AI-generated change, before pushing.
argument-hint: <optional: what to focus the quiz on>
metadata:
  hermes:
    tags: [code-review, git, quiz, understanding, push-gate]
    category: productivity
---

# quiz-axi

quiz-axi quizzes a human reviewer on an AI agent's code diff, then gates `git push` on passing it via a husky pre-push hook (already wired in this repo's `.husky/pre-push`). The point is to make sure the human actually understands what changed and why - not just that they clicked approve - before AI-generated code ships. First generate a small quiz about the diff, then run `node bin/quiz-axi.js review --quiz <quiz.json>` so the human can read the diff, answer questions, and ask follow-up questions, while you grade live through `node bin/quiz-axi.js poll`.

There is no npm package for this yet - always invoke it as `node bin/quiz-axi.js <command>` from the repository root (this repo, `quiz-axi` itself).

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/quiz-axi` explicitly to focus the quiz on something specific - write questions about that.
If it is empty, infer what to quiz on from the most recent change in this conversation.

## When to use

Use quiz-axi after finishing a code change the human should understand before it ships - especially anything non-trivial, anything you generated with significant judgment calls, or anything touching correctness/security-sensitive logic. Run it before the human tries to `git push`; the pre-push hook will block them anyway if you skip this, so doing it proactively avoids a confusing failed push.

## Workflow

1. `git add` any new files that are part of the change. This matters: quiz-axi's diff deliberately excludes untracked (never `git add`ed) files, so the reviewed diff always matches what a later `git push` actually sends. Anything you don't stage will silently not appear in the quiz.
2. Write a `quiz.json` file **outside this repository** (e.g. `/tmp/quiz.json`, or your scratchpad directory) describing 2-5 focused questions about the diff:
   ```jsonc
   {
     "version": 1,
     "diff_summary": "One or two sentences on what changed and why.",
     "questions": [
       {
         "id": "q1",
         "type": "multiple-choice",   // or "free-text"
         "prompt": "Why did X change from A to B?",
         "choices": [{ "id": "a", "text": "..." }, { "id": "b", "text": "..." }],   // multiple-choice only
         "hunk_anchor": { "file": "path/relative/to/repo", "start_line": 10, "end_line": 18 }  // optional; omit or null if not tied to one hunk
       }
     ]
   }
   ```
   Never write `quiz.json` inside the repo - it would get swept into the diff it's describing (same reason untracked files are excluded).
   There is no answer-key field: grading is always live, done by you, never auto-graded even for an "obviously correct" multiple-choice pick.
   Favor questions that require actually looking at the diff to answer, not questions answerable from the PR title alone.
3. Run `node bin/quiz-axi.js review --quiz <path-to-quiz.json> [--base <ref>]` to open a review session in the browser. `--base` picks the branch to diff against; it defaults to the current branch's upstream, then `origin/HEAD`/`origin/main`/`origin/master`, then local `main`/`master`.
4. Do not respond to the user yet. Immediately run `node bin/quiz-axi.js poll <diff_key>` (the `diff_key` from step 3's output). This long-polls silently until the human answers, asks something, or ends the session - leave it running, never kill it.
   - Keep the poll in the foreground by default and let it return activity directly to you.
   - A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify you.
   - Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.
   - If the poll gets killed or times out anyway, just re-run it - queued activity is never lost.
5. When poll returns answered questions (`tag: "quiz-answer"`, see `prompts[].target.question_id`/`.choice_id`/`.value`), grade each one live and honestly:
   `node bin/quiz-axi.js grade <diff_key> --question <id> --verdict correct|incorrect [--feedback "..."]`
   Then poll again.
6. When poll returns a free-text question back from the human (`tag: "message"`), reply on your next poll:
   `node bin/quiz-axi.js poll <diff_key> --agent-reply "<answer>"`
7. Once the human has answered everything (or you judge the review complete), finish it:
   `node bin/quiz-axi.js grade <diff_key> --finish pass|fail [--summary "..."]`
   This is exactly the record `quiz-axi verify` (the pre-push hook) checks - `pass` clears the gate for this diff, `fail` leaves it blocked until re-reviewed.
   If it's a `fail`, explain the gap to the user in this conversation before ending the session.
8. Run `node bin/quiz-axi.js end <diff_key>` when the review is finished.
9. If you edit the code again after finishing (`pass` or `fail`), the diff has changed - the old review record no longer applies, and you must run `review` again before the human can push. This is intentional integrity, not a bug: don't try to work around it.

## Commands & rules

- `node bin/quiz-axi.js review --quiz <quiz.json> [--base <ref>] [--no-open]` - open a review session for the current diff.
- `node bin/quiz-axi.js poll <diff_key> [--agent-reply "..."]` - long-poll for human activity; never pass `--timeout-ms` in normal use, it's a test/debug-only escape hatch.
- `node bin/quiz-axi.js grade <diff_key> --question <id> --verdict correct|incorrect [--feedback "..."]` - grade one answered question.
- `node bin/quiz-axi.js grade <diff_key> --finish pass|fail [--summary "..."]` - seal the review record `verify` checks.
- `node bin/quiz-axi.js end <diff_key>` - end a session as the agent.
- `node bin/quiz-axi.js verify` - what `.husky/pre-push` actually calls; it reads the review record straight off disk, no server needed. You generally never need to run this yourself - it's what blocks the human's `git push` if you skipped the workflow above.
- `node bin/quiz-axi.js stop` - shut down the background server (it also self-stops when idle or once the last session ends with nothing connected).
- `node bin/quiz-axi.js setup hooks` installs *agent* SessionStart hooks (ambient context at the start of a session) - unrelated to the *git* hooks in `.husky/` that gate `git push`. Both are called "hooks" but are different mechanisms.
- The reviewed diff is always computed the same way regardless of push history: `mergeBase(resolved base branch, commit)` vs. that commit. Re-pushing an already-reviewed branch with one more commit re-diffs the whole branch against the same base, not just what's new since the last push - so a small follow-up commit correctly requires re-review too.
