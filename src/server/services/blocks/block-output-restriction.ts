import type { Workflow } from '@civitai/orchestration-client';
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
 * `shared/orchestrator/workflow-data.ts` (`NSFW_CAPPED` for a site cap, `canUpgrade`
 * for `allowMatureContent === false`), with the app token's ceiling in place of the
 * site's domain and viewer settings:
 *   1. No rating yet (`null`, `''`, `'na'`): NOT restricted, `{ url }` with no
 *      `nsfwLevel` — the same as before this field existed. The on-site generator does
 *      not restrict an unrated output for `allowMatureContent` either.
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
 * ⚠️ HOW FAR 'pool' vs 'ceiling' CAN BE TOLD APART. The workflow carries only the
 * resulting flag, not who wrote it, so step 5 infers it from the CURRENT token. Two
 * cases are read as `'pool'` although the site set the flag: a base-model clamp whose
 * `nsfwLevel` cap the orchestrator did not echo back, and a workflow submitted under
 * an SFW token and read under a mature one. Both are still RESTRICTED; only the label
 * is wrong. With an SFW token step 3 always wins first (an SFW ceiling holds no
 * mature level), so an SFW app never sees `'pool'`.
 */
export function classifyBlockOutput(
  media: { url: string; nsfwLevel: string | null },
  workflow: BlockOutputWorkflowFacts,
  ceiling: BlockOutputCeiling
): BlockWorkflowOutput {
  const raw = typeof media.nsfwLevel === 'string' ? media.nsfwLevel.trim().toLowerCase() : '';
  if (raw === '' || raw === 'na') return { url: media.url };
  const rating = RATING_BY_SPELLING.get(raw);
  if (rating === undefined) return restricted('ceiling');
  const level = LEVEL_BY_RATING[rating];
  if ((level & ceiling.maxBrowsingLevel) === 0) return restricted('ceiling');
  const cap =
    typeof workflow.nsfwLevel === 'string'
      ? RATING_BY_SPELLING.get(workflow.nsfwLevel.toLowerCase())
      : undefined;
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

/** True for an entry that carries a url the app may load. */
export function isUnrestrictedOutput(
  output: BlockWorkflowOutput
): output is Extract<BlockWorkflowOutput, { url: string }> {
  return !('restricted' in output && output.restricted === true);
}

const restricted = (reason: 'pool' | 'ceiling'): BlockWorkflowOutput => ({
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
