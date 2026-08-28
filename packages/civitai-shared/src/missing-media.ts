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
import { isProbeableMediaKey } from './media-key';

/**
 * What consulting the media store concluded. 🔴 NEVER a boolean, and never fewer values than there
 * are distinguishable causes.
 *
 * A boolean forces the "could not consult the store" case to be reported as one of the other two,
 * and both readings are wrong. Counting it as present asserts we confirmed an object we never saw;
 * counting it as absent lets a verification step block legitimate moderation whenever credentials
 * are missing, a key is rotated, or the network hiccups. The same reasoning is written out at the
 * upload-completion call site that solved this problem first.
 *
 * 🔴 `NotApplicable` exists for the same reason one step down. It used to be folded into `Unknown`,
 * which meant the not-a-key short-circuit and a genuine store failure emitted an identical log line
 * with an empty `error` — reintroducing, inside the detector, exactly the indistinguishability the
 * log exists to remove. An `unknown` count that silently includes every profile-picture url cannot
 * answer the one question it is watched for: "is the bucket answering at all?"
 */
export const MediaPresence = {
  /** The store answered: the object is there. */
  Present: 'present',
  /** The store answered: the object is NOT there. Refuses the publish. */
  Absent: 'absent',
  /** The store could not be consulted (threw, timed out, unconfigured, 403). Never a refusal. */
  Unknown: 'unknown',
  /**
   * The url is not a key this store issues, so there was nothing to ask. Allows, and is NOT an
   * inconclusive probe — the probe was never run. See `isProbeableMediaKey`.
   */
  NotApplicable: 'not-applicable',
  /**
   * The url can never render for a viewer, whatever the store holds. Refuses — see
   * `isUnrenderableMediaUrl` for the one shape this covers and why it is decided without a probe.
   */
  Unrenderable: 'unrenderable',
} as const;
export type MediaPresence = (typeof MediaPresence)[keyof typeof MediaPresence];

/**
 * Shown to a moderator, verbatim, by both runtimes — the spoke renders it into its form error and
 * the main app puts it on a BAD_REQUEST. So it has to explain what happened and what to do instead,
 * not read like a stack trace.
 */
export const MISSING_MEDIA_PUBLISH_MESSAGE =
  'The media file for this image is missing from storage, so it cannot be published — publishing it would put a permanently broken image on the site. Delete it, or ask the uploader to upload it again.';

/**
 * The other refusal, and it needs its own words: nothing is missing from the store, because the row
 * never referred to the store at all. Telling a moderator to check storage for a `blob:` handle
 * would send them looking for something that was never there.
 */
export const UNRENDERABLE_MEDIA_PUBLISH_MESSAGE =
  'This image points at a browser-session handle (a blob: url) rather than an uploaded file, so it can never load for anyone else and cannot be published. Delete it, or ask the uploader to upload it again.';

/** Thrown when the publish is refused. Never thrown for a verdict that allows. */
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
 * "Is this `Image.url` a key we can ask the store about?" — re-exported, not defined here.
 *
 * 🔴 It is defined in `@civitai/shared/media-key` because the UPLOAD-time existence check needs the
 * same rule and must not carry its own copy: this module used to define its own, by the opposite
 * construction, and the two disagreed on real rows. Read that file for why the test is what it is —
 * in particular for why the premise "every bucket key is a uuid" is FALSE and the predicate is a
 * deliberate under-approximation anyway.
 */
export { isProbeableMediaKey };

/**
 * Is this url broken for every viewer regardless of what any store holds?
 *
 * One shape qualifies today: a `blob:` handle. `URL.createObjectURL` mints a url scoped to the
 * document that created it, and a legacy upload bug persisted some into `Image.url` (see
 * `src/utils/type-guards.ts`, which records that the embedded uuid is a browser handle and "can't
 * be salvaged"). Both renderers pass it through VERBATIM rather than rewriting it to the image CDN
 * — `src/client-utils/cf-images-utils.ts` and `apps/moderator/src/lib/media/edge-url.ts` both do
 * `if (!src || src.startsWith('http') || src.startsWith('blob')) return src;` — so publishing one
 * emits `<img src="blob:…">` into someone else's browser, which resolves to nothing. Forever.
 *
 * 🔴 This is a REFUSAL decided WITHOUT a probe, so it is held to the same bar as `absent` and it is
 * the one case that clears it: the harm is definitional rather than inferred. There is no store
 * state, credential, or bucket name under which a `blob:` row renders, so the false-positive risk
 * that makes every other permanent refusal dangerous does not exist here. The previous rule allowed
 * these on the stated grounds that they "render perfectly well", which was simply wrong.
 *
 * Deliberately NOT extended to `data:` or `http(s):`. `http(s)` really does render — both renderers
 * pass it through and it is the documented legacy-avatar population. `data:` is a different case
 * and is left alone on purpose: it is NOT in either renderer's passthrough set, so it is rewritten
 * into a CDN path and is probably broken too, but "probably broken" is inference, and inference is
 * not enough to justify a permanent refusal. It stays fail-open until someone measures it.
 */
export function isUnrenderableMediaUrl(url: unknown): url is string {
  return typeof url === 'string' && /^blob:/i.test(url);
}

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
      presence: typeof MediaPresence.Absent | typeof MediaPresence.Unrenderable;
      message: string;
    };

/**
 * The whole rule, as a pure function. Refuse on `absent` and `unrenderable` — and only those two.
 *
 * Inability to consult the store is not evidence of loss, so `unknown` allows, and so does
 * `not-applicable`. That is the fail-open half and it is the easy one to get backwards: getting it
 * wrong turns a storage blip into a moderation outage on a queue whose whole job is unblocking
 * content. The two refusing verdicts differ in provenance — one is the store's answer, one is a
 * property of the url itself — which is why they carry different messages.
 */
export function decideMediaPublish(presence: MediaPresence): MediaPublishDecision {
  if (presence === MediaPresence.Absent)
    return { allow: false, presence: MediaPresence.Absent, message: MISSING_MEDIA_PUBLISH_MESSAGE };
  if (presence === MediaPresence.Unrenderable)
    return {
      allow: false,
      presence: MediaPresence.Unrenderable,
      message: UNRENDERABLE_MEDIA_PUBLISH_MESSAGE,
    };
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
   */
  probe: (key: string) => Promise<MediaPresence>;
  /**
   * Called for every `unknown`, with why. Silent fail-open is how a guard lies for months, so the
   * caller is expected to log here. Must not throw.
   *
   * 🔴 NOT called for `not-applicable`. It used to be, because the two shared one verdict, and the
   * resulting log line could not tell a store outage from a profile-picture url — which made the
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
  onRefused?: (presence: typeof MediaPresence.Absent | typeof MediaPresence.Unrenderable) => void;
  /** Optional runtime-appropriate throw (e.g. a tRPC BAD_REQUEST). CONTRACT: it must throw. */
  raise?: (message: string) => void;
};

/**
 * Classify the url, probe it if that is a meaningful thing to do, and refuse the publish when — and
 * only when — the answer is `absent` or the url is one that can never render.
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

  if (isUnrenderableMediaUrl(url)) {
    presence = MediaPresence.Unrenderable;
  } else if (!isProbeableMediaKey(url)) {
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

  if (presence === MediaPresence.Unknown)
    onUnknown?.({ reason: unknownReason, error: probeError });

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
