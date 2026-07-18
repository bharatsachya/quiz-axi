import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { computeCurrentDiff, computeDiffStat, computeRangeDiff, diffKey, parseDiffHunks, parsePrePushStdin } from "../src/diff.js";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function initRepo(dir) {
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "t"], dir);
}

test("computeCurrentDiff produces a diff against the resolved base and diffKey is stable/content-addressed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-diff-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "f.js"), "const a = 1;\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "init"], dir);

    await writeFile(path.join(dir, "f.js"), "const a = 2;\n");

    const first = computeCurrentDiff({ cwd: dir, baseOverride: "HEAD" });
    assert.match(first.diffText, /diff --git a\/f\.js b\/f\.js/);
    assert.match(first.diffText, /-const a = 1;/);
    assert.match(first.diffText, /\+const a = 2;/);

    const second = computeCurrentDiff({ cwd: dir, baseOverride: "HEAD" });
    assert.equal(diffKey(first), diffKey(second), "same content must produce the same diffKey");

    await writeFile(path.join(dir, "f.js"), "const a = 3;\n");
    const third = computeCurrentDiff({ cwd: dir, baseOverride: "HEAD" });
    assert.notEqual(diffKey(first), diffKey(third), "different content must change the diffKey");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffKey is stable across different commit paths that reach the same final content (rebase-equivalent)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-diff-rebase-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "f.js"), "line1\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "init"], dir);
    const base = git(["rev-parse", "HEAD"], dir).trim();

    // Branch A: reach "line1\nline2\n" in one direct commit.
    git(["checkout", "-qb", "branch-a", base], dir);
    await writeFile(path.join(dir, "f.js"), "line1\nline2\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "direct edit"], dir);
    const diffA = computeCurrentDiff({ cwd: dir, baseOverride: base });

    // Branch B: reach the exact same final content via a different intermediate commit.
    git(["checkout", "-qb", "branch-b", base], dir);
    await writeFile(path.join(dir, "f.js"), "line1\nintermediate\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "intermediate edit"], dir);
    await writeFile(path.join(dir, "f.js"), "line1\nline2\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "final edit"], dir);
    const diffB = computeCurrentDiff({ cwd: dir, baseOverride: base });

    assert.equal(diffKey(diffA), diffKey(diffB), "identical final content must produce identical diffKey regardless of path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeDiffStat counts files/insertions/deletions", () => {
  const diffText = [
    "diff --git a/f.js b/f.js",
    "index 111..222 100644",
    "--- a/f.js",
    "+++ b/f.js",
    "@@ -1,2 +1,2 @@",
    "-old1",
    "-old2",
    "+new1",
    "+new2",
    "+new3",
    "",
  ].join("\n");
  const stat = computeDiffStat(diffText);
  assert.equal(stat.files_changed, 1);
  assert.equal(stat.insertions, 3);
  assert.equal(stat.deletions, 2);
});

test("parseDiffHunks extracts per-file new-side line ranges", () => {
  const diffText = [
    "diff --git a/f.js b/f.js",
    "index 111..222 100644",
    "--- a/f.js",
    "+++ b/f.js",
    "@@ -10,2 +10,3 @@",
    " context",
    "+added",
    " context2",
    "",
  ].join("\n");
  const files = parseDiffHunks(diffText);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, "f.js");
  assert.deepEqual(files[0].hunks, [{ startLine: 10, endLine: 12 }]);
});

test("parsePrePushStdin parses ref lines and skips deletions and non-branch refs", () => {
  const zero = "0000000000000000000000000000000000000000";
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const stdin = [
    `refs/heads/feature ${shaA} refs/heads/feature ${shaB}`,
    `refs/heads/deleted-branch ${zero} refs/heads/deleted-branch ${shaB}`,
    `refs/tags/v1 ${shaA} refs/tags/v1 ${zero}`,
    "",
  ].join("\n");
  const refs = parsePrePushStdin(stdin);
  assert.deepEqual(refs, [{ localRef: "refs/heads/feature", localSha: shaA, remoteRef: "refs/heads/feature", remoteSha: shaB }]);
});

test("computeRangeDiff matches computeCurrentDiff's vs-trunk diff regardless of push history (a second push adding one more commit re-diffs against the same base, not the previous push's tip)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quiz-axi-diff-pushhistory-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "f.js"), "const maxRetries = 3;\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "init"], dir);
    git(["branch", "-m", "master"], dir);

    git(["checkout", "-qb", "feature"], dir);
    await writeFile(path.join(dir, "f.js"), "const maxRetries = 5;\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "bump retries"], dir);
    const firstTip = git(["rev-parse", "HEAD"], dir).trim();

    // Review before the first push: whole branch vs. trunk.
    const reviewed1 = computeCurrentDiff({ cwd: dir, baseOverride: "master" });
    // First push (branch new on the remote): computeRangeDiff must match what was reviewed.
    const pushed1 = computeRangeDiff({ cwd: dir, localSha: firstTip, baseOverride: "master" });
    assert.equal(diffKey(reviewed1), diffKey(pushed1), "first push must match the reviewed diff");

    // One more commit on the same branch, as if responding to feedback before a second push.
    await writeFile(path.join(dir, "f.js"), "const maxRetries = 5;\nconst backoffMs = 200;\n");
    git(["add", "f.js"], dir);
    git(["commit", "-qm", "add backoff"], dir);
    const secondTip = git(["rev-parse", "HEAD"], dir).trim();

    // Re-review the updated branch: whole branch vs. trunk (now includes both commits).
    const reviewed2 = computeCurrentDiff({ cwd: dir, baseOverride: "master" });
    assert.notEqual(diffKey(reviewed1), diffKey(reviewed2), "the cumulative diff must have changed after the second commit");

    // Second push: must match the re-review, NOT an incremental diff against the first push's tip.
    const pushed2 = computeRangeDiff({ cwd: dir, localSha: secondTip, baseOverride: "master" });
    assert.equal(diffKey(reviewed2), diffKey(pushed2), "second push must match the re-reviewed cumulative diff, not an incremental diff since the last push");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
