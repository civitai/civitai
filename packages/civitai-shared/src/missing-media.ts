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
 * published by the review queue that same day — so they now serve a 404 to every viewer.
 *
 * 🔴 The rule lives HERE, in one place, because the publish happens in TWO runtimes: the Next.js
 * app's `resolveIngestionError` (Prisma) and the moderator spoke's `resolveIngestionError` (Kysely).
 * A predicate open-coded at two call sites regenerates the same bug at both, and the spoke is the
 * one that actually caused the incident. Each runtime supplies only the PROBE (how to ask its own
 * storage client); the verdict and the refusal are decided here.
 */

/**
 * What consulting the media store concluded. 🔴 THREE values, never a boolean.
 *
 * A boolean forces the "could not consult the store" case to be reported as one of the other two,
 * and both readings are wrong. Counting it as present asserts we confirmed an object we never saw;
 * counting it as absent lets a verification step block legitimate moderation whenever credentials
 * are missing, a key is rotated, or the network hiccups. The same reasoning is written out at the
 * upload-completion call site that solved this problem first.
 */
export const MediaPresence = {
  /** The store answered: the object is there. */
  Present: 'present',
  /** The store answered: the object is NOT there. The only verdict that refuses a publish. */
  Absent: 'absent',
  /** The store could not be consulted (threw, timed out, unconfigured, 403). Never a refusal. */
  Unknown: 'unknown',
} as const;
export type MediaPresence = (typeof MediaPresence)[keyof typeof MediaPresence];

/**
 * Shown to a moderator, verbatim, by both runtimes — the spoke renders it into its form error and
 * the main app puts it on a BAD_REQUEST. So it has to explain what happened and what to do instead,
 * not read like a stack trace.
 */
export const MISSING_MEDIA_PUBLISH_MESSAGE =
  'The media file for this image is missing from storage, so it cannot be published — publishing it would put a permanently broken image on the site. Delete it, or ask the uploader to upload it again.';

/** Thrown when the store ANSWERED that the object is absent. Never thrown for an unknown answer. */
export class MissingMediaError extends Error {
  constructor(message: string = MISSING_MEDIA_PUBLISH_MESSAGE) {
    super(message);
    this.name = 'MissingMediaError';
  }
}

/**
 * The stored classification a scan failure carries when the media itself can never be fetched or
 * decoded. It is a classification written at scan time, NOT a match on the scanner's prose: keying
 * a queue off the reason text would be walked past by a single scanner reword. The class is the
 * TRIGGER for treating an image as missing-media; an existence check against the store is the
 * VERDICT.
 */
export const IMAGE_SCAN_FAILURE_CLASS_PERMANENT = 'permanent';

/**
 * Can this `Image.url` be handed to the media store as an object key at all?
 *
 * 🔴 NOT every `Image.url` is a bucket key. Most are a bare UUID, but some rows hold a full
 * external URL — profile pictures accept a whitelisted external avatar CDN and store it verbatim,
 * and that row is created and ingested like any other, so it carries today's timestamp and lands in
 * the review queue's window. A legacy bug also persisted `blob:` handles.
 *
 * Handing one of those to a bucket as a Key returns 404, which is indistinguishable from a genuine
 * miss — so without this check the guard would REFUSE, permanently and with no override, an image
 * that renders perfectly well. That is strictly worse than the bug the guard exists to fix.
 *
 * The main app's delete path excludes non-keys for the same REASON ("Legacy avatar rows hold a full
 * external URL where every other row holds a bucket key") but with a different TEST — it checks
 * `url.startsWith('http')`. The two disagree in both directions: `startsWith('http')` would exclude
 * a key literally named `httpfoo` and would NOT exclude `blob:` or `data:`; this one does the
 * opposite. They are not yet consolidated, so do not read this as one rule in two places — it is
 * two spellings of one idea, and the delete path's is the older.
 *
 * The predicate lives HERE because the two PUBLISH runtimes reach the store through different
 * clients that fail differently on a non-key url (one 404s to `absent`, the other throws to
 * `unknown`), so leaving it to them produced opposite verdicts for the same row.
 *
 * Conservative in the safe direction: anything carrying a URI scheme is treated as not-a-key, which
 * yields `unknown` and therefore ALLOWS. A false negative here costs nothing; a false positive is
 * the permanent refusal above. A `/` cannot appear in a scheme, so a key containing a colon later
 * in a path is unaffected.
 */
export function isProbeableMediaKey(url: string | null | undefined): url is string {
  return !!url && !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

export type MediaPublishDecision =
  | { allow: true; presence: typeof MediaPresence.Present | typeof MediaPresence.Unknown }
  | { allow: false; presence: typeof MediaPresence.Absent; message: string };

/**
 * The whole rule, as a pure function. Refuse on `absent` — and ONLY on `absent`.
 *
 * Inability to consult the store is not evidence of loss, so `unknown` allows. That is the
 * fail-open half and it is the easy one to get backwards: getting it wrong turns a storage blip
 * into a moderation outage on a queue whose whole job is unblocking content.
 */
export function decideMediaPublish(presence: MediaPresence): MediaPublishDecision {
  if (presence === MediaPresence.Absent)
    return { allow: false, presence: MediaPresence.Absent, message: MISSING_MEDIA_PUBLISH_MESSAGE };
  return { allow: true, presence };
}

export type AssertMediaPresentOptions = {
  /** Ask the runtime's own storage client. May throw — a throw is an `unknown` answer, not a miss. */
  probe: () => Promise<MediaPresence>;
  /** Called for every `unknown`, with the probe's error when it threw. Silent fail-open is how a
   *  guard lies for months, so the caller is expected to log here. Must not throw. */
  onUnknown?: (error: unknown) => void;
  /**
   * Called for every REFUSAL, before it is thrown. Must not throw.
   *
   * The mirror of `onUnknown`, needed for the same reason in the opposite direction: a misconfigured
   * bucket name answers 404 for EVERY key, which this module reads as `absent`. That refuses every
   * publish while looking exactly like a run where the media really was missing. A silent
   * fail-CLOSED lies just as long as a silent fail-open.
   */
  onRefused?: () => void;
  /** Optional runtime-appropriate throw (e.g. a tRPC BAD_REQUEST). CONTRACT: it must throw. */
  raise?: (message: string) => void;
};

/**
 * Run a caller-supplied probe and refuse the publish when — and only when — the store answered
 * that the object is absent.
 *
 * The probe is called inside the try on purpose: a runtime whose storage client throws on
 * construction (unconfigured credentials) must land on `unknown` and allow, exactly as a network
 * failure does. A guard that can fail the path by its own absence is worse than no guard.
 */
export async function assertMediaPresentForPublish({
  probe,
  onUnknown,
  onRefused,
  raise,
}: AssertMediaPresentOptions): Promise<MediaPublishDecision> {
  let presence: MediaPresence;
  let probeError: unknown;
  try {
    presence = await probe();
  } catch (error) {
    probeError = error;
    presence = MediaPresence.Unknown;
  }

  if (presence === MediaPresence.Unknown) onUnknown?.(probeError);

  const decision = decideMediaPublish(presence);
  if (!decision.allow) {
    onRefused?.();
    raise?.(decision.message);
    // Backstop, not dead code: `raise` is contractually a throw, but a caller that passes one which
    // merely RETURNS would otherwise fall through and publish the broken image — the exact defect
    // this module exists to remove. The refusal must not depend on the caller getting that right.
    throw new MissingMediaError(decision.message);
  }
  return decision;
}
