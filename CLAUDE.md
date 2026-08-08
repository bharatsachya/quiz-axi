# quiz-axi

A local, unpublished CLI that makes a human prove they understood an AI-authored diff before it ships. After an agent finishes a change it writes a layered explainer + short quiz about that diff, opens it in the browser, and grades the human live. A husky `pre-push` hook (`.husky/pre-push` → `quiz-axi verify`) refuses `git push` for any diff that hasn't been reviewed and passed.

**This repo gates its own pushes.** When you finish a non-trivial change here, run the `quiz-axi` skill (`.claude/skills/quiz-axi/SKILL.md`) before the human pushes — the pre-push hook will block them otherwise. Keep a decision journal *as you work* (outside the repo, e.g. scratchpad), per that skill.

## Run / test

- Node 22+, ESM (`"type": "module"`). **No build step** — runs straight from `src/*.js`; `bin/quiz-axi.js` is a 3-line shim around `src/cli.js`'s `run()`.
- `node bin/quiz-axi.js <command>` — invoke the CLI (no npm package exists; never assume a global `quiz-axi`).
- `bun run test` / `npm test` → `node --test test/*.test.js`. Tests use built-in `node:test`, one `*.test.js` per source module.
- Runtime deps are intentionally tiny: `express` (local server), `open` (browser), `axi-sdk-js`. Don't add dependencies without a strong reason.

## Module map (`src/`)

| File | Responsibility |
| --- | --- |
| `cli.js` | Command dispatch (`run`) + all human-facing output builders (`create*Output`). Every command lives here. |
| `diff.js` | Diff identity & git plumbing: `diffKey`, `resolveBaseRef`, `computeCurrentDiff` (working tree), `computeRangeDiff` (pushed commit), `parsePrePushStdin`, hunk parsing. |
| `session-store.js` | `SessionStore` over `~/.quiz-axi/state.json`: `sessions` (live state) + `review_index` (sealed pass/fail record `verify` reads). |
| `server.js` | Local express server, long-poll endpoints, and server-side HTML rendering (split diff, explainer ladder, guided tour, question cards). |
| `chrome-client.js` | Browser-side DOM/network layer (chat, answer submission, tour, auto-close). Loaded as `<script type="module">`. |
| `client/*.js` | Pure browser-side logic, served at `/client/<name>.js` **and** imported by `node:test` — the tested code is the shipped code. Add a module → add its name to `CLIENT_MODULES` in `server.js`. |
| `quiz.js` | Load + validate/normalize `quiz.json` (versions 1–3), match hunk anchors to the diff, and report (never silently drop) anchors that point at nothing. |
| `paths.js` | State dir, ports, bind/link host resolution from env. |

## Core invariants — do not break these

- **Content-addressed identity.** A review is keyed by `diffKey = sha256(repoRoot + "\n" + diffText).slice(0,16)` (`diff.js`), *not* a commit SHA. Computed identically at review time and push time. Any real content change → new key → gate correctly demands re-review. This is the whole point; don't "fix" re-reviews away.
- **`review` diffs the working tree; `verify` diffs the pushed commit.** The pre-push hook always gets ref-update lines on stdin → `computeRangeDiff` (commit-based, ignores dirty files). A manual no-stdin `quiz-axi verify` falls back to `computeCurrentDiff` (working tree). Mismatches fail *closed* ("no review found"), never silently through.
- **Untracked files are excluded from the reviewed diff.** Keeps what `review` sees identical to what `git push` sends. `quiz.json` must be written *outside* the repo for this reason.
- **Base resolution is shared** by `review`/`verify`/hook (`resolveBaseRef`): `--base`/`QUIZ_AXI_BASE_BRANCH` → `@{upstream}` → `origin/HEAD` → `origin/main` → `origin/master` → local `main` → local `master`.
- **Grading is always live; there is no answer key.** `quiz.json` carries no correct-answer field — even an "obviously correct" multiple-choice pick only counts once the agent calls `grade`. Don't add an answer key.
- **Claims that point at nothing are counted and shown, never silently dropped.** A `hunk_anchor` that matches no real hunk renders as ordinary unlinked prose, which looks exactly like prose that was grounded — so `collectUngroundedAnchors` reports every one, to the human on the page and to the agent in `review`'s output. Same principle as the uncovered-hunks tour stop, from the other side: there, code nobody explained; here, an explanation with no code under it.
- **The gate needs no live server.** `verify` reads `review_index` straight off disk. Keep it that way — the hook must work with nothing running.

## Escape hatches (behavior to preserve)

- `git push --no-verify` — git's own bypass, leaves no record. The human's call, never suggest it as a shortcut.
- `review --self-authored` — seals a diff instantly with an honest `method: "self-authored"` record (vs `method: "quiz"`). For a human sealing their own hand-written change. **An agent must never run this to skip a review.**

## Conventions

- Output-builder functions in `cli.js` are pure and unit-tested (`cli-output.test.js`) — keep user-facing strings there, not inline in command handlers.
- HTML/CSS/client JS are hand-written template strings in `server.js` / `chrome-client.js` — no framework, no bundler. Escape all interpolated values (`escapeHtml`, `jsonScript`).
- Browser JS is real ES modules over HTTP (still no bundler). `STATIC_ASSETS` in `server.js` is an explicit allowlist — never serve a path built from the request. A module graph *aborts* on a failed import, so an unlisted module is a blank page, not a degraded one; the `served modules` tests in `server.test.js` are what catch that.
- Env vars (see README "Environment variables"): `QUIZ_AXI_PORT`, `QUIZ_AXI_HOST`, `QUIZ_AXI_STATE_DIR`, `QUIZ_AXI_BASE_BRANCH`, `QUIZ_AXI_NO_OPEN`, `QUIZ_AXI_IDLE_TIMEOUT_MS`, `QUIZ_AXI_DEBUG`.
- When changing `quiz.json` shape, bump the version and keep `validateQuizSpec` accepting older versions — `quiz.js` supports 1–3 today.
