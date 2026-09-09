/**
 * Shared rule for "may this image be published given what the media store says about its object?".
 *
 * An `Image` row can reference a media key that has no object behind it. The scan pipeline already
 * detects that correctly — the scanner reports the media could not be downloaded, the failure is
 * stamped `permanent`, and the row sits at `ingestion = 'Error'`, `nsfwLevel = 0`, i.e. invisible.
 * The harm came from the moderator ingestion-error-review queue, which published such rows anyway:
 * it set `ingestion = 'Scanned'` + an nsfwLevel unconditionally, with nothing checking that the
 * media exists. Measured over ~92,000 image creations in 24h: 10 images had unfetchable media, all
 * 10 confirmed absent from the media store by a direct existence check, and 8 of those 10 were
 * published by the review queue that same day — so they served a 404 to every viewer.
 *
 * 🔴 The rule lives HERE, in one place, because the publish happens in TWO runtimes: the Next.js
 * app's `resolveIngestionError` (Prisma) and the moderator spoke's `resolveIngestionError` (Kysely).
 * A predicate open-coded at two call sites regenerates the same bug at both, and the spoke is the
 * one that actually caused the incident. Each runtime supplies only the PROBE (how to ask its own
 * storage client); the verdict and the refusal are decided here.
 */
import { isProbeableMediaKey } from './media-key';

/**
 * What consulting the media store concluded. 🔴 NEVER a boolean, and never fewer values than there
 * are distinguishable causes.
 *
 * A boolean forces the "could not consult the store" case to be reported as one of the other two,
 * and both readings are wrong. Counting it as present asserts we confirmed an object we never saw;
 * counting it as absent lets a verification step block legitimate moderation whenever credentials
 * are missing, a key is rotated, or the network hiccups.
 *
 * 🔴 `NotApplicable` exists for the same reason one step down. Folding it into `Unknown` would make
 * the not-a-key short-circuit and a genuine store failure emit an identical log line with an empty
 * `error` — reintroducing, inside the detector, exactly the indistinguishability the log exists to
 * remove. An `unknown` count that silently includes every profile-picture url cannot answer the one
 * question it is watched for: "is the bucket answering at all?"
 */
export const MediaPresence = {
  /** The store answered: the object is there. */
  Present: 'present',
  /**
   * The store answered: the object is NOT there. Refuses the publish.
   *
   * 🔴 THIS VERDICT CANNOT DISTINGUISH A MISSING OBJECT FROM A MISSING BUCKET, AND NO CHECK ON THE
   * ERROR NAME CAN FIX THAT — do not add one, it will be dead code.
   *
   * Both runtimes probe with a `HeadObject`. HTTP forbids a body on a HEAD response, so the AWS
   * SDK has nothing to parse an error `Code` out of and falls back to the status alone
   * (`loadRestXmlErrorCode` in `@aws-sdk/core`: `if (output.statusCode == 404) return 'NotFound'`).
   * Measured against the installed SDK at a local origin, with a GET control to prove the
   * instrument can observe the name at all:
   *
   *     HEAD, 404, empty body ............................ err.name = 'NotFound'
   *     HEAD, 404, <Error><Code>NoSuchBucket</Code> ...... err.name = 'NotFound'
   *     HEAD, 404, x-amz-error-code: NoSuchBucket ........ err.name = 'NotFound'
   *     GET,  404, <Error><Code>NoSuchBucket</Code> ...... err.name = 'NoSuchBucket'   ← control
   *
   * So a mistyped or moved bucket answers 404 for EVERY key and lands here, which refuses every
   * publish while emitting `onRefused` lines identical to a genuine run of misses. That hazard is
   * OPEN and is not closed by anything in this module. It is stated rather than papered over,
   * because the version of this comment that claimed it was handled was worse than none: a
   * maintainer would have believed the guard existed.
   *
   * Closing it needs a discriminator a HEAD actually carries — a separate bucket-reachability
   * check, or a rate test (a run of `absent` across DISTINCT keys in a window is a bucket problem,
   * not N missing objects). Both are more than this module should decide alone.
   */
  Absent: 'absent',
  /** The store could not be consulted (threw, timed out, unconfigured, 403). Never a refusal. */
  Unknown: 'unknown',
  /**
   * The url is not a key this store issues, so there was nothing to ask. Allows, and is NOT an
   * inconclusive probe — the probe was never run. See `isProbeableMediaKey`.
   */
  NotApplicable: 'not-applicable',
} as const;
export type MediaPresence = (typeof MediaPresence)[keyof typeof MediaPresence];

/**
 * Shown to a moderator, verbatim, by both runtimes — the spoke renders it into its form error and
 * the main app puts it on a BAD_REQUEST. So it has to explain what happened and what to do instead,
 * not read like a stack trace.
 *
 * 🔴 IT MUST NOT NAME AN ACTION THE SURFACE DOES NOT OFFER. An earlier wording said "Delete it",
 * and no surface this message reaches has a delete: the spoke's ingestion-errors page exposes
 * exactly one action, `resolve` (pinned by that route's own test), and the spoke's
 * `deleteImagesByIds` is wired only into article moderation. A refusal that instructs an impossible
 * action is a dead end wearing the costume of a remedy — the moderator re-clicks, which costs
 * another existence probe per click and changes nothing.
 *
 * So it names only what is TRUE on every surface: the file is gone, re-uploading is the fix, and
 * the row stays hidden until then. Whoever can act on that is not necessarily the person reading
 * it, and the message does not pretend otherwise.
 */
export const MISSING_MEDIA_PUBLISH_MESSAGE =
  'The media file for this image is missing from storage, so it cannot be published — publishing it would put a permanently broken image on the site. Re-uploading the file is the only fix; until then the image stays hidden.';

/** Thrown when the publish is refused. Never thrown for a verdict that allows. */
export class MissingMediaError extends Error {
  constructor(message: string = MISSING_MEDIA_PUBLISH_MESSAGE) {
    super(message);
    this.name = 'MissingMediaError';
  }
}

/**
 * "Is this `Image.url` a key we can ask the store about?" — re-exported, not defined here.
 *
 * 🔴 It is defined in `@civitai/shared/media-key` so that any future existence check (the
 * upload-time one is the obvious next caller) uses the same rule rather than carrying its own copy.
 * Read that file for why the test is what it is — in particular for why the premise "every bucket
 * key is a uuid" is FALSE and the predicate is a deliberate under-approximation anyway.
 */
export { isProbeableMediaKey };

/**
 * The three answers a media STORE can give. See `AssertMediaPresentOptions.probe` for why the probe
 * is typed on this rather than on the full four-valued `MediaPresence`.
 */
export type MediaProbeAnswer =
  | typeof MediaPresence.Present
  | typeof MediaPresence.Absent
  | typeof MediaPresence.Unknown;

export type MediaPublishDecision =
  | {
      allow: true;
      presence:
        | typeof MediaPresence.Present
        | typeof MediaPresence.Unknown
        | typeof MediaPresence.NotApplicable;
    }
  | {
      allow: false;
      presence: typeof MediaPresence.Absent;
      message: string;
    };

/**
 * The whole rule, as a pure function. Refuse on `absent` — and only on `absent`.
 *
 * Inability to consult the store is not evidence of loss, so `unknown` allows, and so does
 * `not-applicable`. That is the fail-open half and it is the easy one to get backwards: getting it
 * wrong turns a storage blip into a moderation outage on a queue whose whole job is unblocking
 * content.
 */
export function decideMediaPublish(presence: MediaPresence): MediaPublishDecision {
  if (presence === MediaPresence.Absent)
    return { allow: false, presence: MediaPresence.Absent, message: MISSING_MEDIA_PUBLISH_MESSAGE };
  return { allow: true, presence };
}

/**
 * The maximum number of characters of a probe failure that reaches a log line.
 *
 * A storage client's error message can embed the remote response BODY verbatim, which is
 * third-party text of unbounded length — an HTML error page, an XML fault document, or whatever a
 * misbehaving proxy returns. Writing that straight to stdout puts an attacker-influenced,
 * unbounded blob into the log pipeline once per refused publish.
 */
export const MEDIA_PROBE_ERROR_MAX_LENGTH = 200;

/**
 * Render a probe failure as a bounded, single-line string safe to log.
 *
 * Truncation is marked, so a reader can tell a short message from a clipped one; without the marker
 * a cut-off body reads as a complete (and different) error.
 */
export function summarizeProbeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= MEDIA_PROBE_ERROR_MAX_LENGTH) return flat;
  return `${flat.slice(0, MEDIA_PROBE_ERROR_MAX_LENGTH)}…[truncated]`;
}

/** Why a probe could not answer. The two are indistinguishable in the payload without this. */
export type MediaProbeUnknownReason =
  /** The probe threw — client could not be built, network failed, credentials rotated, timeout. */
  | 'probe-threw'
  /** The probe ran and the store itself declined to answer (a 403, a 5xx, an unclassified shape). */
  | 'store-inconclusive';

export type AssertMediaPresentOptions = {
  /**
   * The row's `Image.url`. Classified HERE, not by the caller: this function decides whether the
   * probe runs at all, so a runtime cannot reintroduce its own idea of what a key is.
   */
  url: unknown;
  /**
   * Ask the runtime's own storage client about a key. 🔴 Called ONLY with a value that already
   * passed `isProbeableMediaKey`, so it never has to re-check, and never can re-check differently.
   * May throw — a throw is an `unknown` answer, not a miss.
   *
   * 🔴 Its return type is NARROWER than `MediaPresence`, deliberately. `not-applicable` is a
   * decision this module makes ABOUT the url, before any store is consulted, and a probe that could
   * return it would defeat `onSkipped`, whose whole job is counting the short-circuit. A bucket
   * answers one of three things — it is there, it is not, or it would not say.
   */
  probe: (key: string) => Promise<MediaProbeAnswer>;
  /**
   * Called for every `unknown`, with why. Silent fail-open is how a guard lies for months, so the
   * caller is expected to log here. Must not throw.
   *
   * 🔴 NOT called for `not-applicable`. Sharing one verdict between the two would make the
   * resulting log line unable to tell a store outage from a profile-picture url — which makes the
   * one number this hook exists to produce unreadable.
   */
  onUnknown?: (info: { reason: MediaProbeUnknownReason; error: unknown }) => void;
  /** Called when the url was not a key, so no probe ran. Allows. Must not throw. */
  onSkipped?: () => void;
  /**
   * Called for every REFUSAL, before it is thrown, with which verdict caused it. Must not throw.
   *
   * The mirror of `onUnknown`, needed for the same reason in the opposite direction: a misconfigured
   * bucket name answers 404 for EVERY key, which this module reads as `absent`. That refuses every
   * publish while looking exactly like a run where the media really was missing. A silent
   * fail-CLOSED lies just as long as a silent fail-open.
   */
  onRefused?: (presence: typeof MediaPresence.Absent) => void;
  /** Optional runtime-appropriate throw (e.g. a tRPC BAD_REQUEST). CONTRACT: it must throw. */
  raise?: (message: string) => void;
};

/**
 * Classify the url, probe it if that is a meaningful thing to do, and refuse the publish when — and
 * only when — the store answers `absent`.
 *
 * The probe is called inside the try on purpose: a runtime whose storage client throws on
 * construction (unconfigured credentials) must land on `unknown` and allow, exactly as a network
 * failure does. A guard that can fail the path by its own absence is worse than no guard.
 */
export async function assertMediaPresentForPublish({
  url,
  probe,
  onUnknown,
  onSkipped,
  onRefused,
  raise,
}: AssertMediaPresentOptions): Promise<MediaPublishDecision> {
  let presence: MediaPresence;
  let probeError: unknown;
  let unknownReason: MediaProbeUnknownReason = 'store-inconclusive';

  if (!isProbeableMediaKey(url)) {
    presence = MediaPresence.NotApplicable;
    onSkipped?.();
  } else {
    try {
      presence = await probe(url);
    } catch (error) {
      probeError = error;
      unknownReason = 'probe-threw';
      presence = MediaPresence.Unknown;
    }
  }

  if (presence === MediaPresence.Unknown) onUnknown?.({ reason: unknownReason, error: probeError });

  const decision = decideMediaPublish(presence);
  if (!decision.allow) {
    onRefused?.(decision.presence);
    raise?.(decision.message);
    // Backstop, not dead code: `raise` is contractually a throw, but a caller that passes one which
    // merely RETURNS would otherwise fall through and publish the broken image — the exact defect
    // this module exists to remove. The refusal must not depend on the caller getting that right.
    throw new MissingMediaError(decision.message);
  }
  return decision;
}
