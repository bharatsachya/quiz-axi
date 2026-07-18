import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { AxiError } from "axi-sdk-js";

// Array-form args only, never a shell string, so branch/path names with shell
// metacharacters can't do anything unexpected.
export function runGit(args, { cwd = process.cwd(), allowedExitCodes = [0] } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new AxiError(`Failed to run git ${args.join(" ")}: ${result.error.message}`, "SERVER_ERROR");
  }
  if (!allowedExitCodes.includes(result.status)) {
    throw new AxiError(
      `git ${args.join(" ")} failed: ${(result.stderr || "").trim() || `exit ${result.status}`}`,
      "SERVER_ERROR",
    );
  }
  return result.stdout;
}

export function repoRoot(cwd = process.cwd()) {
  return runGit(["rev-parse", "--show-toplevel"], { cwd }).trim();
}

function refExists(ref, cwd) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, encoding: "utf8" });
  return result.status === 0;
}

function tryRef(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  const ref = result.stdout.trim();
  return ref || null;
}

// Resolution chain, first match wins: explicit override (--base / QUIZ_AXI_BASE_BRANCH) ->
// @{upstream} of the current branch -> origin/HEAD -> origin/main -> origin/master -> local
// main -> local master.
export function resolveBaseRef({ cwd = process.cwd(), override } = {}) {
  const explicit = override || process.env.QUIZ_AXI_BASE_BRANCH;
  if (explicit) {
    if (!refExists(explicit, cwd)) {
      throw new AxiError(`Base ref not found: ${explicit}`, "VALIDATION_ERROR", [
        "Pass a valid --base <ref>, or unset QUIZ_AXI_BASE_BRANCH",
      ]);
    }
    return explicit;
  }
  const candidates = [
    () => tryRef(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd),
    () => tryRef(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd),
    () => (refExists("origin/main", cwd) ? "origin/main" : null),
    () => (refExists("origin/master", cwd) ? "origin/master" : null),
    () => (refExists("main", cwd) ? "main" : null),
    () => (refExists("master", cwd) ? "master" : null),
  ];
  for (const candidate of candidates) {
    const ref = candidate();
    if (ref) return ref;
  }
  throw new AxiError("Could not resolve a base branch to diff against", "VALIDATION_ERROR", [
    "Pass --base <ref>, set QUIZ_AXI_BASE_BRANCH, or ensure the branch has an upstream / origin/main exists",
  ]);
}

export function mergeBase(a, b, { cwd = process.cwd() } = {}) {
  return runGit(["merge-base", a, b], { cwd }).trim();
}

export function isZeroSha(sha) {
  return /^0+$/.test(String(sha || ""));
}

// Review-time snapshot: diffs the merge-base against the working tree (index + unstaged
// combined for tracked files, plus staged new files), so uncommitted changes are included.
// This is what `review` calls.
//
// Deliberately excludes genuinely untracked (never `git add`ed) files: `review`'s diff must
// match what `computeRangeDiff` sees at push time (committed content only), or the diffKey
// computed at review time would never match the one the pre-push hook re-derives from the
// pushed commit - silently defeating the whole gate. `git diff <tree-ish>` (single positional
// ref, no --cached) already includes staged new files' content, so requiring `git add` before
// `review` is enough; it is never a hidden gap, since nothing untracked can be pushed anyway.
export function computeCurrentDiff({ cwd = process.cwd(), baseOverride } = {}) {
  const root = repoRoot(cwd);
  const base = resolveBaseRef({ cwd: root, override: baseOverride });
  const mb = mergeBase(base, "HEAD", { cwd: root });
  const diffText = runGit(["diff", mb], { cwd: root });
  return { repoRoot: root, baseRef: base, diffText, stat: computeDiffStat(diffText) };
}

// Pre-push snapshot: diffs committed content only, against mergeBase(resolvedBaseBranch,
// localSha) - deliberately the SAME "whole branch vs. trunk" semantic `computeCurrentDiff`
// uses, not an incremental "only what's new since the remote's last known tip" diff.
// A remote-relative diff would make the reviewed diffKey depend on push history: the first
// push of a branch (remote at all-zero) would match `review`'s vs-trunk diff, but a second
// push adding one more commit on an already-pushed branch would suddenly diff against the
// remote's previous tip instead of trunk, producing a different key than what was reviewed
// even though nothing about "the PR" changed except one more commit - defeating the gate for
// the single most common push pattern. Using the same base for every push keeps `review` and
// `verify` in agreement regardless of push history.
export function computeRangeDiff({ cwd = process.cwd(), localSha, baseOverride } = {}) {
  const root = repoRoot(cwd);
  const base = resolveBaseRef({ cwd: root, override: baseOverride });
  const mb = mergeBase(base, localSha, { cwd: root });
  const diffText = runGit(["diff", mb, localSha], { cwd: root });
  return { repoRoot: root, baseRef: base, diffText, stat: computeDiffStat(diffText) };
}

// Parses the standard pre-push hook stdin protocol:
//   <local-ref> SP <local-sha1> SP <remote-ref> SP <remote-sha1> LF  (repeated)
// Filters to refs/heads/* and skips branch deletions (local-sha1 all-zero).
export function parsePrePushStdin(text) {
  const refs = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    if (!localRef.startsWith("refs/heads/")) continue;
    if (isZeroSha(localSha)) continue;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

// Content-addressed identity: stable across a rebase that reproduces the same patch text
// (blob hashes are content hashes), changes the instant real content changes. repoRoot is
// folded into the hash so two different repos never collide in the shared state.json.
export function diffKey({ repoRoot: root, diffText }) {
  return crypto.createHash("sha256").update(`${root}\n${diffText}`).digest("hex").slice(0, 16);
}

export function computeDiffStat(diffText) {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of String(diffText || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      filesChanged += 1;
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (line.startsWith("+")) {
      insertions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { files_changed: filesChanged, insertions, deletions };
}

// Parses unified diff text into per-file hunk line ranges (on the "new" side), used to match a
// quiz question's hunk_anchor against the diff actually computed server-side.
export function parseDiffHunks(diffText) {
  const files = [];
  let current = null;
  const fileHeaderRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of String(diffText || "").split("\n")) {
    const fileMatch = fileHeaderRe.exec(line);
    if (fileMatch) {
      current = { file: fileMatch[2], hunks: [] };
      files.push(current);
      continue;
    }
    const hunkMatch = hunkHeaderRe.exec(line);
    if (hunkMatch && current) {
      const start = Number(hunkMatch[1]);
      const count = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      current.hunks.push({ startLine: start, endLine: count > 0 ? start + count - 1 : start });
    }
  }
  return files;
}
