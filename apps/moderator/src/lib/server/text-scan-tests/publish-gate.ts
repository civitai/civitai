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

  const candidates = await doneRuns(db)
    .where('kind', '=', 'draft')
    .where('run_by', '=', userId)
    .execute();
  const run = candidates.find(
    (r) => (r.prompt_overrides as Record<string, unknown> | null)?.[INTENT_PROMPT_KEY] === content
  );
  if (!run)
    return refuse(
      'Run this exact text on the intent test set first. Only a finished run you started counts.'
    );
  return judgeRun(db, run, baseId, live);
}

/**
 * Whether the live intent text has a run that would pass the publish gate today (anyone's run: a
 * baseline of the live version, or a draft of the same text). False after a restore until one runs.
 */
export async function checkLiveIntent(
  db: Db,
  live: Pick<LabPrompts, 'active' | 'config'>
): Promise<PublishCheck> {
  const baseId = live.active.base?.id;
  const intent = live.active[INTENT_PROMPT_KEY];
  if (baseId === undefined || !intent) return refuse('The intent prompt has no saved version.');
  const candidates = await doneRuns(db).execute();
  const run = candidates.find((r) =>
    r.kind === 'baseline'
      ? (r.prompt_ids as Record<string, unknown>)[INTENT_LABEL] === intent.id
      : (r.prompt_overrides as Record<string, unknown> | null)?.[INTENT_PROMPT_KEY] ===
        intent.content
  );
  if (!run) return refuse('No finished run of this version on the intent test set.');
  return judgeRun(db, run, baseId, live);
}

const doneRuns = (db: Db) =>
  db
    .selectFrom('text_scan_test_run')
    .select(['id', 'kind', 'prompt_ids', 'prompt_overrides', 'model', 'thinking'])
    .where('set_id', '=', String(INTENT_EVAL_SET_ID))
    .where('status', '=', 'done')
    .orderBy('id', 'desc');

type DoneRun = Awaited<ReturnType<ReturnType<typeof doneRuns>['execute']>>[number];

async function judgeRun(
  db: Db,
  run: DoneRun,
  baseId: number,
  live: Pick<LabPrompts, 'config'>
): Promise<PublishCheck> {
  // A draft of any other key (the base above all) tested a combination that will not be live.
  const drafted = Object.keys((run.prompt_overrides as Record<string, unknown> | null) ?? {});
  if (drafted.some((key) => key !== INTENT_PROMPT_KEY))
    return refuse('The run also drafted another prompt. Run the intent text alone.');
  const ids = run.prompt_ids as Record<string, unknown>;
  if (
    ids.base !== baseId ||
    run.model !== live.config.model ||
    run.thinking !== live.config.thinking
  )
    return refuse(
      'The base prompt, model or thinking setting changed since the run. Run the text again.'
    );

  const [cases, results] = await Promise.all([
    runnableCases(db, INTENT_EVAL_SET_ID).select(['c.id', 'c.expected', 'c.updated_at']).execute(),
    db
      .selectFrom('text_scan_test_result')
      .select(['case_id', 'status', 'output', 'created_at'])
      .where('run_id', '=', run.id)
      .execute(),
  ]);
  if (!cases.length) return refuse('The intent test set has no case to check against.');
  const byCase = new Map(results.map((r) => [r.case_id, r]));

  let uncovered = 0;
  let falseClears = 0;
  let falseFlags = 0;
  for (const c of cases) {
    const result = byCase.get(c.id);
    // A case edited after its verdict was written was not scanned as it is now. Per verdict, not per
    // run: a baseline top-up scans cases added after the run row was created.
    const changed =
      !!result && new Date(c.updated_at).getTime() > new Date(result.created_at).getTime();
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
      `The run is missing a verdict for ${uncovered} current case(s), or they changed after it. Run the text again.`
    );
  if (falseClears || falseFlags)
    return refuse(
      `The run cleared ${falseClears} case(s) expected to be detected and flagged ${falseFlags} expected to be clear. Both must be 0.`
    );
  return { ok: true, runId: Number(run.id) };
}
