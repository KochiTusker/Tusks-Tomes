// Fast-forward guard for pushes to the public `main` branch.
//
// WHY THIS EXISTS
// ===============
// Every install updates itself with `git pull --ff-only <remote> main`
// (scripts/update/apply.sh and apply.ps1, step 5). A release commit that is
// not a DESCENDANT of the commit users already hold fails that pull for every
// user simultaneously, and the updater has no fallback — the only recovery is
// a manual re-clone, which most people will never do.
//
// This is not hypothetical. v2.0 was published as a fresh parentless commit
// and did exactly that to everyone on v1.x. Discipline alone had already
// failed once by the time this guard was written, so the check lives at the
// chokepoint (the pre-push hook) where it applies however the release is
// built.
//
// SCOPE
// =====
// `refs/heads/main` only. `gh-pages` is deliberately exempt: publish-site.mjs
// rebuilds it as a parentless commit on every publish, which is correct — it
// carries built HTML and nobody pulls it.
//
// Extracted from scripts/audit-push-range.mjs so it can be unit-tested against
// a fake git runner. Testing it through the real script would mean running the
// full multi-layer secret scan four times, and the "remote object missing"
// branch is impractical to reproduce for real.

export const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * @param {string[]} refLines  git's pre-push stdin lines:
 *                             "<localRef> <localSha> <remoteRef> <remoteSha>"
 * @param {(args: string[]) => number} gitStatus  runs git, returns exit code.
 * @returns {Array<{layer: string, file: string, detail: string}>} blocking findings
 */
export function checkFastForward(refLines, gitStatus) {
  const findings = [];

  for (const line of refLines) {
    const [, localSha, remoteRef, remoteSha] = line.split(" ");
    if (remoteRef !== "refs/heads/main") continue;

    // Deleting the branch, or creating it for the first time: there is nothing
    // for the new commit to be a descendant OF.
    if (localSha === ZERO_SHA || remoteSha === ZERO_SHA) continue;

    // Testing ancestry needs the remote's commit in the local object store. It
    // usually is. When it is not, a fast-forward and a re-root are
    // indistinguishable, and guessing either way is wrong — fail with the fix.
    if (gitStatus(["cat-file", "-e", `${remoteSha}^{commit}`]) !== 0) {
      findings.push({
        layer: "fast-forward",
        file: "refs/heads/main",
        detail:
          `cannot verify this push fast-forwards — ${remoteSha.slice(0, 8)} is not in the local ` +
          `object store. Run \`git fetch public main\`, then push again.`,
      });
      continue;
    }

    if (gitStatus(["merge-base", "--is-ancestor", remoteSha, localSha]) !== 0) {
      findings.push({
        layer: "fast-forward",
        file: "refs/heads/main",
        detail:
          `${localSha.slice(0, 8)} is not a descendant of the published ${remoteSha.slice(0, 8)}. ` +
          `Every existing install updates with \`git pull --ff-only\`, so this would break all of ` +
          `them at once. Build the release as an ordinary commit on top of public/main rather ` +
          `than a fresh orphan.`,
      });
    }
  }

  return findings;
}
