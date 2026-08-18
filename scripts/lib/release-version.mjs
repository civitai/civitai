// Version arithmetic for scripts/release-app.mjs, kept separate so it is testable
// without shelling out to git or cutting a real release.
//
// ── The failure this exists to stop ─────────────────────────────────────────────
// `release-app.mjs` derives the next version from `apps/<app>/package.json` ON THE
// CURRENT BRANCH. If that branch is behind the app's released history, the tag it
// computes is wrong in one of two ways:
//
//   * it ALREADY EXISTS  -> `git tag` aborts, but only AFTER the release commit has
//     been made, leaving a junk commit on the branch;
//   * it does NOT exist but is a DIFFERENT LINE (a minor/major bump off a stale
//     base) -> nothing collides, the tag becomes the HIGHEST for that app, and
//     since the Flux ImagePolicy selects the highest semver in range rather than
//     the most recently pushed, that stale build is what production runs.
//
// The second is the dangerous one and has no natural brake. Measured 2026-08-17:
// `apps/moderator` is 0.0.1 on `main` while 0.0.26 is live, because all 26 releases
// were cut from `moderator-app-pages` (211 commits / +38,630 lines never merged to
// main). `pnpm release:moderator` from main collides on the existing 0.0.2 and
// aborts — but `release:moderator:minor` computes 0.1.0, which does NOT exist, and
// would deploy main's stale copy of the app to production.

/** Parse a plain `x.y.z` version. Returns null for anything else (pre-release, junk). */
export function parseSemver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Compare two `x.y.z` strings. >0 if a is newer, <0 if b is newer, 0 if equal. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`cannot compare non-semver versions: ${a} vs ${b}`);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * Highest released version among `tags` carrying `tagPrefix`, or null if none.
 * Tags that do not parse are ignored rather than throwing: an app's tag namespace
 * can legitimately contain hand-cut oddities, and one of those must not be able to
 * disable the guard for every subsequent release.
 */
export function highestTagVersion(tags, tagPrefix) {
  let best = null;
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (!tag.startsWith(tagPrefix)) continue;
    const version = tag.slice(tagPrefix.length);
    if (!parseSemver(version)) continue;
    if (best === null || compareSemver(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Is this branch's package.json behind the app's released history?
 *
 * Equal is fine — that is the normal state right before a release. Ahead is fine
 * too (someone bumped by hand). Only BEHIND is refused, because that is the state
 * in which the computed tag does not continue the released line.
 */
export function releaseSkew({ currentVersion, tags, tagPrefix }) {
  const highest = highestTagVersion(tags, tagPrefix);
  if (highest === null) return { behind: false, current: currentVersion, highest: null };
  if (!parseSemver(currentVersion)) {
    throw new Error(`package.json version is not a plain x.y.z version: ${currentVersion}`);
  }
  return {
    behind: compareSemver(currentVersion, highest) < 0,
    current: currentVersion,
    highest,
  };
}

/** The refusal text. Separate from the check so a test can pin what an operator is told. */
export function skewMessage({ appDir, tagPrefix, current, highest, branch }) {
  return [
    `refusing to release: ${appDir}/package.json is ${current} on '${branch}', but ${tagPrefix}${highest} is already released.`,
    `This branch is BEHIND the app's released history, so the tag this would cut does not continue that line.`,
    `Either it collides with an existing tag (the release aborts half-done), or — for a minor/major bump — it becomes`,
    `the highest tag for this app and Flux deploys THIS branch's code, because the ImagePolicy selects the highest`,
    `semver rather than the most recent push.`,
    ``,
    `Fix the branch, not the number: merge or rebase the branch that carries the releases, then release from there.`,
    `Setting the version to ${highest} by hand removes the collision that is currently the only thing stopping this.`,
  ].join('\n');
}
