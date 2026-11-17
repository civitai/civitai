/**
 * Types for the GitHub Actions run an App submit came from (React-free and zod-free, so the
 * review UI and the store page can import them).
 *
 * 🔴 WHAT THIS IS, AND WHAT IT IS NOT. GitHub signs an OIDC token for a workflow run, and the
 * server checks that signature. So these fields are facts about WHICH RUN sent the submit: its
 * repository, the tag it ran for, and that tag's commit. They are NOT a claim that the uploaded
 * bundle was built from that commit. The bundle is built and uploaded by the developer's own
 * workflow, which can upload anything. The honest sentence is "submitted by a GitHub Actions run
 * of <repo> at <tag> (<sha>)", and no UI, API or log may say more (no "verified build", no
 * "secure"). Moderator review is unchanged.
 *
 * 🔴 A DIFFERENT TRUST LEVEL FROM `sourceCommit` / `sourceDirty`. Those are what the submitting
 * client CLAIMED; these come from a token GitHub signed. Never alias, default or fall back between
 * the two, and never between either and `forgejoCommitSha`.
 */

/** The run facts stored on a publish request (`app_block_publish_requests.actions_run_*`). */
export type ActionsRunSource = {
  /** `owner/repo`, from the token's `repository` claim. */
  repository: string;
  /** GitHub's numeric repository id, as the string the token carries. Survives a rename. */
  repositoryId: string;
  /** GitHub's numeric owner id, as the string the token carries. Survives a rename. */
  repositoryOwnerId: string;
  /** The 40-hex commit the run was triggered for. */
  sha: string;
  /** The full ref, e.g. `refs/tags/v1.2.3`. */
  ref: string;
  /** The workflow file and ref that ran, e.g. `owner/repo/.github/workflows/release.yml@refs/tags/v1.2.3`. */
  workflowRef: string;
  /** `public` | `private` | `internal`, at the time of the run. */
  repositoryVisibility: string;
  /** The Actions run id, as the string the token carries. */
  runId: string;
};

/**
 * The moderator review's provenance block for one publish request: the client's CLAIM and the
 * checked Actions run, side by side and never merged.
 */
export type ReviewSourceProvenance = {
  /** Client-claimed commit (`source_commit`); null = the client sent none. */
  claimedCommit: string | null;
  /** Client-claimed dirty flag (`source_dirty`); null = unknown, false = claimed clean. */
  claimedDirty: boolean | null;
  /** The checked GitHub Actions run; null = none recorded (or not readable here yet). */
  actionsRun: ActionsRunSource | null;
};
