import type { Workflow } from '@civitai/orchestration-client';
import { isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import { NsfwLevel } from '~/server/common/enums';
import {
  allowMatureContentForCeiling,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type {
  BlockWorkflowOutput,
  BlockWorkflowOutputRating,
} from '~/server/schema/blocks/workflow.schema';

/**
 * Whether ONE App Block workflow output may be handed to the app as a url, or must be
 * reported as RESTRICTED (`{ restricted: true, reason }`, no url, no rating).
 *
 * WHY. The orchestrator can refuse mature content for a workflow in two ways, and in
 * both it still reports the output `available` with a url that does not serve the
 * real media (an image serves blurred, a video does not serve at all):
 *   - the SITE asked for it: an SFW app's submit sends `allowMatureContent: false`
 *     (`blockOutputClamp`, from the token's `maxBrowsingLevel`), and a base model that
 *     restricts mature output adds `nsfwLevel: 'pg13'`;
 *   - the PAYING POOL caused it: a submit that sent no `allowMatureContent` has it set
 *     at charge time from the Buzz account that paid (the orchestrator's mature-content
 *     restriction detection runs only when the flag is still unset). Blue Buzz from a
 *     non-member sets it to `false`.
 * Restricted urls are withheld from the app entirely, so a restricted output reaches
 * the app only as a position in `outputs`.
 *
 * THE DECISION, in order — it mirrors the on-site generator's blob rules in
 * `shared/orchestrator/workflow-data.ts` (`holdUnrated` / `PENDING_RATING` for an
 * output not rated yet, `NSFW_CAPPED` for a site cap, `canUpgrade` for
 * `allowMatureContent === false`), with the app token's ceiling in place of the site's
 * domain and viewer settings:
 *   0. BLOCKED by the orchestrator (a `blockedReason` other than `none`): the output
 *      keeps its POSITION, with no url. `MatureContent` is a maturity block, so it is
 *      `{ restricted: true, reason: 'ceiling' }`; any other reason (moderation) is
 *      `{ blocked: true }`.
 *   1. NOT RATED YET (`null` / `''`): HELD as `{ pending: true }` — no url, no rating —
 *      when its rating COULD STILL RESTRICT it ({@link ratingCouldRestrict}) and it is
 *      an output the orchestrator rates (`isUnratedOutput`: not audio). The
 *      orchestrator marks a workflow succeeded seconds before it rates the last output,
 *      so a url handed out now would be a restricted output's url a moment later.
 *      When nothing could restrict it, `{ url }`.
 *   1b. NEVER TO BE RATED (`opts.neverRated`: a never-rated video engine, an
 *      `imageResourceTraining` sample, a mesh on a finished step with no rating
 *      source): where a rating could restrict it, `{ restricted: true, reason:
 *      'unrated' }` — terminal, no url, no `ratingPending`, refused like any restricted
 *      slot; otherwise `{ url }`. A hold would never release.
 *      `'na'` is a verdict with no level (the provider moderated it): `{ url }`.
 *   2. A rating this module does not know: restricted, `'ceiling'` (fail closed).
 *   3. Above the token's `maxBrowsingLevel` ceiling: restricted, `'ceiling'`.
 *   4. Above the workflow's own `nsfwLevel` cap (the site's base-model clamp):
 *      restricted, `'ceiling'`.
 *   5. Mature (R and up) on a workflow with `allowMatureContent === false`:
 *      restricted, and the reason says WHO set the flag. `'ceiling'` when this token's
 *      submit would have sent `false` itself (`allowMatureContentForCeiling`);
 *      otherwise `'pool'`, because then the only writer left is the orchestrator's
 *      charge-time detection.
 *   6. Otherwise `{ url, nsfwLevel }`.
 *
 * A 3D mesh is never rated itself; the producers copy its thumbnail's and the
 * workflow's `model3DPreview` rating onto it BEFORE this runs (`propagateMeshRating` in
 * `services/blocks/workflow.service`), and a mesh with neither is unrated (rule 1).
 *
 * ⚠️ HOW FAR 'pool' vs 'ceiling' CAN BE TOLD APART. The workflow carries only the
 * resulting flag, not who wrote it, so step 5 infers it from the CURRENT token. Two
 * cases are read as `'pool'` although the site set the flag: a base-model clamp whose
 * `nsfwLevel` cap the orchestrator did not echo back, and a workflow submitted under
 * an SFW token and read under a mature one. Both are still RESTRICTED; only the label
 * is wrong. With an SFW token step 3 always wins first (an SFW ceiling holds no
 * mature level), so an SFW app never sees `'pool'`.
 */
export function classifyBlockOutput(
  media: {
    url: string;
    nsfwLevel: string | null;
    /** The orchestrator blob `type` (`image`, `video`, `audio`, `model3d`), when known. */
    type?: string | null;
    blockedReason?: string | null;
  },
  workflow: BlockOutputWorkflowFacts,
  ceiling: BlockOutputCeiling,
  /** `neverRated`: no rating will EVER arrive for this output (rule 1b). */
  opts: { neverRated?: boolean } = {}
): BlockWorkflowOutput {
  const blockedReason = media.blockedReason;
  if (typeof blockedReason === 'string' && blockedReason.toLowerCase() !== 'none') {
    return blockedReason.toLowerCase() === 'maturecontent' ? restricted('ceiling') : BLOCKED;
  }
  const raw = typeof media.nsfwLevel === 'string' ? media.nsfwLevel.trim().toLowerCase() : '';
  if (raw === 'na') return { url: media.url };
  if (raw === '') {
    // 1b. No rating will ever come: FAIL CLOSED where one could restrict it — terminal,
    // never held, never a url.
    if (opts.neverRated) {
      return ratingCouldRestrict(workflow, ceiling) ? restricted('unrated') : { url: media.url };
    }
    const holdable = isUnratedOutput(
      {
        // A mesh arrives here only while a rating source is still pending
        // (`propagateMeshRating`), so it is held whatever its format.
        type: (KNOWN_TYPES.has(media.type ?? '') ? media.type : 'image') as
          | 'image'
          | 'video'
          | 'audio'
          | 'model3d',
        available: true,
        nsfwLevel: undefined,
        blockedReason: undefined,
      },
      false
    );
    return holdable && ratingCouldRestrict(workflow, ceiling) ? PENDING : { url: media.url };
  }
  const rating = RATING_BY_SPELLING.get(raw);
  if (rating === undefined) return restricted('ceiling');
  const level = LEVEL_BY_RATING[rating];
  if ((level & ceiling.maxBrowsingLevel) === 0) return restricted('ceiling');
  const cap = workflowCap(workflow);
  if (cap !== undefined && RATING_ORDER.indexOf(rating) > RATING_ORDER.indexOf(cap)) {
    return restricted('ceiling');
  }
  if (MATURE_RATINGS.has(rating) && workflow.allowMatureContent === false) {
    return restricted(
      allowMatureContentForCeiling(ceiling.maxBrowsingLevel) === false ? 'ceiling' : 'pool'
    );
  }
  return { url: media.url, nsfwLevel: rating };
}

/**
 * Whether a rating that has not landed yet COULD make an output restricted — the
 * condition under which an unrated output is HELD rather than handed out. Any of:
 *   - the token's ceiling does not cover every rating (PG through XXX);
 *   - the workflow refused mature content (`allowMatureContent === false`);
 *   - the workflow carries an `nsfwLevel` cap below XXX (an unrecognised cap counts).
 * A mature token on an unrestricted, uncapped workflow can be handed any rating, so
 * there an unrated output keeps its url at once.
 */
export function ratingCouldRestrict(
  workflow: BlockOutputWorkflowFacts,
  ceiling: BlockOutputCeiling
): boolean {
  if ((ceiling.maxBrowsingLevel & ALL_RATINGS_FLAG) !== ALL_RATINGS_FLAG) return true;
  if (workflow.allowMatureContent === false) return true;
  if (typeof workflow.nsfwLevel === 'string' && workflow.nsfwLevel.length > 0) {
    const cap = workflowCap(workflow);
    return cap === undefined || cap !== 'xxx';
  }
  return false;
}

function workflowCap(workflow: BlockOutputWorkflowFacts): BlockWorkflowOutputRating | undefined {
  return typeof workflow.nsfwLevel === 'string'
    ? RATING_BY_SPELLING.get(workflow.nsfwLevel.toLowerCase())
    : undefined;
}

const PENDING: BlockWorkflowOutput = { pending: true };
const BLOCKED: BlockWorkflowOutput = { blocked: true };
const KNOWN_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'model3d']);

/** The workflow fields the decision reads. Never forwarded to the app. */
export type BlockOutputWorkflowFacts = Pick<Workflow, 'allowMatureContent' | 'nsfwLevel'>;

/**
 * The app token's maturity ceiling — a civitai browsing-level bitflag. Build it with
 * {@link blockOutputCeilingFromClaims}; it is REQUIRED by every snapshot and listing
 * producer, so a new producer cannot forget it.
 */
export type BlockOutputCeiling = { readonly maxBrowsingLevel: number };

/**
 * The ceiling from a verified token's `maxBrowsingLevel` claim. FAIL CLOSED to SFW
 * for a token without a numeric claim — the same fallback `resolveBlockMaturity`
 * applies to the submit.
 */
export function blockOutputCeilingFromClaims(claims: {
  maxBrowsingLevel?: number;
}): BlockOutputCeiling {
  const value = claims.maxBrowsingLevel;
  return {
    maxBrowsingLevel:
      typeof value === 'number' && Number.isFinite(value) ? value : sfwBrowsingLevelsFlag,
  };
}

/**
 * The refusal for a publish / post / persist naming a RESTRICTED output position. One
 * spelling for all three, so an app can match it. BAD_REQUEST: the position exists and
 * is in range, it is simply not usable by this app; it is never replaced by another.
 */
export function restrictedOutputMessage(position: number): string {
  return `output ${position} is restricted`;
}

/** The refusal for naming a position whose output is still being rated (`{ pending }`). */
export function pendingOutputMessage(position: number): string {
  return `output ${position} is still being rated, try again shortly`;
}

/** True for an entry that carries a url the app may load. */
export function isUnrestrictedOutput(
  output: BlockWorkflowOutput
): output is Extract<BlockWorkflowOutput, { url: string }> {
  return 'url' in output && typeof output.url === 'string';
}

const restricted = (reason: 'pool' | 'ceiling' | 'unrated'): BlockWorkflowOutput => ({
  restricted: true,
  reason,
});

const RATING_ORDER: readonly BlockWorkflowOutputRating[] = ['pg', 'pg13', 'r', 'x', 'xxx'];

const MATURE_RATINGS: ReadonlySet<BlockWorkflowOutputRating> = new Set<BlockWorkflowOutputRating>([
  'r',
  'x',
  'xxx',
]);

/** Orchestrator spellings → the one rating the app sees. `g` is the off-site PG. */
const RATING_BY_SPELLING: ReadonlyMap<string, BlockWorkflowOutputRating> = new Map<
  string,
  BlockWorkflowOutputRating
>([
  ['g', 'pg'],
  ['pg', 'pg'],
  ['pg13', 'pg13'],
  ['pg-13', 'pg13'],
  ['r', 'r'],
  ['x', 'x'],
  ['xxx', 'xxx'],
]);

const LEVEL_BY_RATING: Readonly<Record<BlockWorkflowOutputRating, number>> = {
  pg: NsfwLevel.PG,
  pg13: NsfwLevel.PG13,
  r: NsfwLevel.R,
  x: NsfwLevel.X,
  xxx: NsfwLevel.XXX,
};

/** Every rating's bit, PG through XXX. */
const ALL_RATINGS_FLAG = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;
