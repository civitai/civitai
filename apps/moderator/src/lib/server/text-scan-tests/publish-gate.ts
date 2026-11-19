import type { LabPrompts } from '../text-scan-lab/harness-client';
import type { PromptKey } from '$lib/text-scan-lab/types';
import type { Expected } from '$lib/text-scan-tests/expected';
import { INTENT_EVAL_SET_ID, INTENT_LABEL } from '$lib/text-scan-tests/intent-set';
import { scoreCase, type ResultStatus } from '$lib/text-scan-tests/score';
import type { RunsDeps } from './runs';
import { runnableCases } from './store';

type Db = RunsDeps['db'];

export const INTENT_PROMPT_KEY = `label:${INTENT_LABEL}` as const satisfies PromptKey;

export type PublishCheck = { ok: true; runId: number } | { ok: false; reason: string };

const refuse = (reason: string): PublishCheck => ({ ok: false, reason });

/**
 * Whether new text for the intent prompt may be published: the saver's own latest finished draft
 * run of this exact text on the pinned set, under the live base prompt, model and thinking setting,
 * scanned every current case and met the bar (no expected-detected case cleared, no expected-clear
 * case flagged). The saver must hold the intent publish permission; the caller checks that.
 */
export async function checkIntentPublish(
  db: Db,
  input: { content: string; userId: number; live: Pick<LabPrompts, 'active' | 'config'> }
): Promise<PublishCheck> {
  const { content, userId, live } = input;
  const baseId = live.active.base?.id;
  if (baseId === undefined) return refuse('The base prompt has no saved version.');

  const candidates = await db
    .selectFrom('text_scan_test_run')
    .select(['id', 'prompt_ids', 'prompt_overrides', 'model', 'thinking', 'created_at'])
    .where('set_id', '=', String(INTENT_EVAL_SET_ID))
    .where('kind', '=', 'draft')
    .where('status', '=', 'done')
    .where('run_by', '=', userId)
    .orderBy('id', 'desc')
    .execute();
  const run = candidates.find(
    (r) => (r.prompt_overrides as Record<string, unknown> | null)?.[INTENT_PROMPT_KEY] === content
  );
  if (!run)
    return refuse(
      'Run this exact text on the intent test set first. Only a finished run you started counts.'
    );

  const ids = run.prompt_ids as Record<string, unknown>;
  if (
    ids.base !== baseId ||
    run.model !== live.config.model ||
    run.thinking !== live.config.thinking
  )
    return refuse(
      'The base prompt, model or thinking setting changed since your run. Run the text again.'
    );

  const [cases, results] = await Promise.all([
    runnableCases(db, INTENT_EVAL_SET_ID).select(['c.id', 'c.expected', 'c.updated_at']).execute(),
    db
      .selectFrom('text_scan_test_result')
      .select(['case_id', 'status', 'output'])
      .where('run_id', '=', run.id)
      .execute(),
  ]);
  if (!cases.length) return refuse('The intent test set has no case to check against.');
  const byCase = new Map(results.map((r) => [r.case_id, r]));
  const ranAt = new Date(run.created_at).getTime();

  let uncovered = 0;
  let falseClears = 0;
  let falseFlags = 0;
  for (const c of cases) {
    const result = byCase.get(c.id);
    // A case added or edited after the run started was not scanned as it is now.
    const changed = new Date(c.updated_at).getTime() > ranAt;
    if (changed || !result || result.status !== 'ok') {
      uncovered++;
      continue;
    }
    const expected = (c.expected as Expected | null)?.[INTENT_LABEL];
    if (expected === undefined) continue;
    const score = scoreCase(
      { [INTENT_LABEL]: expected },
      { status: result.status as ResultStatus, output: result.output }
    );
    if (score.state !== 'scored') uncovered++;
    else if (score.pass) continue;
    else if (score.labels.some((l) => l.label === INTENT_LABEL && l.predicted === null))
      uncovered++;
    else if (expected) falseClears++;
    else falseFlags++;
  }
  if (uncovered)
    return refuse(
      `Your run is missing a verdict for ${uncovered} current case(s), or they changed after it. Run the text again.`
    );
  if (falseClears || falseFlags)
    return refuse(
      `Your run cleared ${falseClears} case(s) expected to be detected and flagged ${falseFlags} expected to be clear. Both must be 0.`
    );
  return { ok: true, runId: Number(run.id) };
}
