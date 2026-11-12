export const PRE_PUBLISH_CHECKS = ['nsfw', 'images', 'real_person', 'moderator_release'] as const;
export type PrePublishCheck = (typeof PRE_PUBLISH_CHECKS)[number] | 'gate';

/** `released` is a moderator publishing a gated model, which is not gated. */
export type PrePublishOutcome = 'pass' | 'pending' | 'refused' | 'held' | 'released';
export type GateOutcome = 'pass' | 'pending' | 'refused' | 'held';

/** Which plain message the owner sees on a refusal. */
export type GateRefusal = 'nsfw' | 'images' | 'image_error' | 'no_images';

/** How the publish was asked for, so the resolver can ask again the same way. */
export type GateScope = 'model' | 'version' | 'private';

export type CheckResult = {
  check: Exclude<PrePublishCheck, 'gate' | 'moderator_release'>;
  outcome: GateOutcome;
  /** Ids and states only: the log is evidence of what was checked, never policy. */
  detail?: Record<string, unknown>;
};

export type GateDecision = {
  outcome: GateOutcome;
  checks: CheckResult[];
  refusal?: GateRefusal;
};

export type PrePublishGateMeta = {
  state: 'pending' | 'refused' | 'held' | 'passed';
  runId: string;
  scope: GateScope;
  versionIds: number[];
  /** ISO. The publish date asked for; the resolver keeps it (a past one publishes now). */
  publishedAt?: string;
  /** The same date in epoch ms: the resolver compares this, since Postgres cannot cast every ISO year. */
  publishedAtMs?: number;
  requestedAt: string;
  refusal?: GateRefusal;
  /** `check:outcome` per check at the last logged evaluation, so re-checks log only changes. */
  summary?: string[];
  /** Versions a pass or a moderator's release cleared to go live; a later run keeps them. */
  passedVersionIds?: number[];
  /** Resolver passes that failed with an error; the run ends after too many. */
  attempts?: number;
  /** A private model's publish also asked to make its versions public. */
  publishVersions?: boolean;
};
