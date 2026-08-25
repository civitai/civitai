/**
 * Model / version NAME moderation harness.
 *
 * Answers two questions that the live pipeline cannot: does a given detector separate a
 * genuinely-unsafe NAME from an innocent one, and which detector does it better. Then, once
 * you trust the answer, flips the worst offenders.
 *
 *   pnpm exec tsx --env-file=.env scripts/oneoffs/model-name-moderation-harness.ts <options>
 *
 * WHAT IT SCANS — the name ALONE, for both models and versions. This is deliberately not
 * `buildModelModerationText`, which is name + description and is what the live pipeline sends.
 * A description is where the context lives; a name is 2-6 words with none. The whole reason
 * this harness exists is that the two are different problems, so a verdict from here is not
 * comparable to a verdict from the pipeline and must not be read as one.
 *
 * SELECTORS (exactly one)
 *   --names "a" --names "b"     ad-hoc strings. No database, no writes, ever. Use this to
 *                               iterate on a term list or a threshold.
 *   --model-ids 1,2,3           specific models.
 *   --all                       every published model in the id window, no term filter. The
 *                               unbiased corpus — a term-selected sample cannot show you a
 *                               false positive. regex scanner only.
 *   --terms a,b,c               id-windowed term select over published models, matching the
 *     [--cursor N]              backfill endpoint's paging exactly. The window is fixed
 *     [--window 50000]          because the ILIKE cannot use an index and match-count paging
 *     [--limit 200]             degenerates into a full-table scan.
 *
 * DETECTORS
 *   --scanner regex|xguard|both   default: both
 *   --list <source>               which term list the `regex` detector uses. Default
 *                                 `blocked-words`:
 *
 *     blocked-words   `blocked-words.json` (391) through the profanity filter's own matcher
 *                     and whitelist, minus its density gate. The list this repo already uses
 *                     to censor text; the only reason it does not already catch titles is
 *                     that gate. Reports which list entry fired.
 *
 *                     ⚠️ This matcher SUBSTRING-matches, and the whitelist does not cover the
 *                     cases that matter for titles. Measured on eight control names: it fires
 *                     on Essex, Unisex, Sussex, Middlesex and Scunthorpe — five false
 *                     positives out of six flags. The same nine terms via `--list file`, which
 *                     is whole-word, flag the three real offenders and none of the five.
 *                     So `blocked-words` is a good SELECTOR and a bad verdict; use it to find
 *                     which terms are worth curating, not to decide anything.
 *     nsfw-words      `hasNsfwWords` (82 = words-nsfw-prompt ∪ words-paddle-nsfw). ALREADY
 *                     applied to `model.name` client-side to hide models from viewers who
 *                     cannot see NSFW — so this asks whether a name we already hide should be
 *                     flagged in the database. Boolean only; it never says which term fired.
 *     file            the curated subset. Lives at `local/model-name-terms.json` — `local/` is
 *                     gitignored, which is the point; see the README beside it for how each
 *                     term was chosen and what was deliberately left out.
 *
 *   --terms-file <path>           with `--list file`. JSON `LabelRegexSpec`:
 *                                 { "triggers": [...], "phrasePatterns": [...],
 *                                   "carveOutPatterns": [...] }
 *   --wait 30                     seconds to wait on each XGuard call
 *
 * NOT offered: `words-nsfw-soft.json` and `words-nsfw.json`. They carry `booty`, `twerk`,
 * `oiled`, `dtf`, `netflix and chill` — fine as a soft signal on a prompt, false positives on
 * a title, and flagging a model is not a soft outcome. (`words-nsfw.json` is imported by
 * nothing at all.)
 *
 * OUTPUT
 *   --out <path>                  full per-name JSON report. Without it you get the summary
 *                                 table only, which is not enough to judge a false positive.
 *
 * WRITES (both off by default)
 *   --record-versions             persist version-name findings to `Model.meta.textModeration`
 *                                 for moderator review. Records; never flags.
 *   --apply --min-score 0.90      flip `Model.nsfw` + lock it for models whose MODEL-NAME scan
 *                                 puts a level label at or above `--min-score`. `--min-score`
 *                                 has no default on purpose: "egregious" is the judgement this
 *                                 harness exists to inform, so it has to be typed in.
 *
 * A version name never flips anything FROM HERE, whatever it scores — this harness only records.
 * The automatic path (`model-version-moderation.adapter.ts`) does set `ModelVersion.nsfw`; these
 * findings exist to tune the curated term list it selects with.
 *
 * The apply path is `applyModelTextNsfwFlag`, the same function the live moderation callback
 * uses, so a flip from here recomputes browsing levels (which queues the model's Meilisearch
 * document), busts the origin-side public model response cache on both browsing-level keys,
 * and lands in the model's change history attributed to `xguard-name-harness` rather than to
 * whoever last saved the model. Models already carrying a moderator lock on `nsfw` are left
 * alone. Not flag-gated, for the same reason the backfill endpoint is not: the situations this
 * runs in are the ones the flags are down for.
 *
 * ON COMMITTING A LIST: the built-in sources are lists this repo already ships, so using them
 * adds no new disclosure. The CURATED SUBSET is different — "these are the words we auto-flag
 * on" is a decision rule, and this repo is public and permanently world-readable (CLAUDE.md →
 * Security). It stays in gitignored `local/`. Do not move it under `src/`.
 */
import { readFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { dbRead } from '~/server/db/client';
import {
  applyModelTextNsfwFlag,
  MODEL_MODERATION_LEVEL_LABELS,
  MODEL_MODERATION_SCAN_LABELS,
  recordModelVersionNameForensics,
  resolveBackfillCursor,
} from '~/server/services/model-moderation.adapter';
import {
  collectMatchedTerms,
  triggeredLabelDetails,
  triggeredLabelKeys,
} from '~/server/services/moderation-label-helpers';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { matchSpec, type LabelRegexSpec } from '~/server/services/scanner-label-regex';
import { getProfanityFilter } from '~/libs/profanity-simple';
import { hasNsfwWords } from '~/utils/metadata/audit-base';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { ModelStatus } from '~/shared/utils/prisma/enums';

type TermSource = 'blocked-words' | 'nsfw-words' | 'file';

const LEVEL_LABELS: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);
const HARNESS_SOURCE = 'xguard-name-harness';
const REGEX_LABEL = 'egregious-name-terms';

type LabelDetail = { label: string; score: number; threshold: number };

type Verdict = {
  kind: 'model' | 'version';
  modelId: number | null;
  versionId: number | null;
  name: string;
  /** null when the detector did not run. Distinct from "ran and found nothing". */
  regex: { matched: boolean; reason: string; matchedTerms: string[] } | null;
  xguard: {
    triggeredLabels: string[];
    labels: LabelDetail[];
    matchedTerms: string[];
    levelScore: number | null;
    error?: string;
  } | null;
};

const { values } = parseArgs({
  options: {
    names: { type: 'string', multiple: true },
    'model-ids': { type: 'string' },
    terms: { type: 'string' },
    all: { type: 'boolean', default: false },
    cursor: { type: 'string' },
    window: { type: 'string', default: '50000' },
    limit: { type: 'string', default: '200' },
    scanner: { type: 'string', default: 'both' },
    list: { type: 'string', default: 'blocked-words' },
    'terms-file': { type: 'string' },
    versions: { type: 'boolean', default: true },
    'no-versions': { type: 'boolean', default: false },
    wait: { type: 'string', default: '30' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string' },
    'record-versions': { type: 'boolean', default: false },
    apply: { type: 'boolean', default: false },
    'min-score': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const scanner = values.scanner as 'regex' | 'xguard' | 'both';
if (!['regex', 'xguard', 'both'].includes(scanner)) fail('--scanner must be regex|xguard|both');

const selectors = [values.names, values['model-ids'], values.terms, values.all || undefined].filter(
  Boolean
);
if (selectors.length !== 1) fail('pass exactly one of --names, --model-ids, --terms, --all');
if (values.all && scanner !== 'regex')
  fail(
    '--all is a whole-corpus sweep; run it with --scanner regex (one XGuard call per name is not that)'
  );

const scanVersions = values.versions && !values['no-versions'];
const wait = Number(values.wait);
const concurrency = Number(values.concurrency);
const minScore = values['min-score'] !== undefined ? Number(values['min-score']) : null;

if (values.apply && minScore === null) fail('--apply requires an explicit --min-score');
// Strictly above 0: `--min-score 0` satisfies `>= 0` and then selects every candidate carrying
// any level score at all, which turns the guard that exists to make --apply deliberate into
// the value that makes it unconditional.
if (values.apply && !(minScore! > 0 && minScore! <= 1)) fail('--min-score must be >0 and <=1');
if (values.apply && scanner === 'regex')
  fail('--apply reads an XGuard score; run with --scanner xguard or both');
if (values.apply && values.names) fail('--apply needs real models; --names has no ids to flip');
if (values['record-versions'] && values.names)
  fail('--record-versions needs real models; --names has no ids to write to');

const list = values.list as TermSource;
if (!['blocked-words', 'nsfw-words', 'file'].includes(list))
  fail('--list must be blocked-words|nsfw-words|file');
if (list === 'file' && !values['terms-file']) fail('--list file requires --terms-file');
if (values['terms-file'] && list !== 'file') fail('--terms-file requires --list file');

let regexSpec: LabelRegexSpec | null = null;
if (scanner !== 'xguard' && list === 'file') {
  try {
    regexSpec = JSON.parse(readFileSync(values['terms-file']!, 'utf-8')) as LabelRegexSpec;
  } catch (e) {
    // A raw JSON.parse stack here reads as a bug in the harness. The common cause is a shell
    // eating a backslash out of a carve-out pattern on the way into the file.
    fail(`could not read --terms-file: ${(e as Error).message}`);
  }
  if (!Array.isArray(regexSpec!.triggers)) fail('--terms-file must contain a `triggers` array');
}

/**
 * The term detector, over one of the lists this repo already ships.
 *
 * `blocked-words` runs the profanity filter's own dataset through `analyze()` rather than
 * `evaluateContent()`. The distinction is the whole point: the filter's list already holds the
 * terms a bad title is made of, but `evaluateContent` needs five matches or ten unique profane
 * words before it will say so, and a three-word title can never reach that. `analyze()` is the
 * same matcher and the same whitelist with the density gate removed — so this measures the
 * list, not the threshold that has been hiding it.
 *
 * `nsfw-words` is `hasNsfwWords`, which is already applied to `model.name` client-side in
 * `useApplyHiddenPreferences` to hide models from viewers who cannot see NSFW. Running it here
 * asks whether the names it already hides should be flagged in the database instead.
 */
function matchTerms(name: string): { matched: boolean; reason: string; matchedTerms: string[] } {
  if (list === 'file')
    return (({ matched, reason, matchedTerms }) => ({ matched, reason, matchedTerms }))(
      matchSpec(REGEX_LABEL, regexSpec!, name)
    );

  if (list === 'nsfw-words') {
    // Boolean-only by construction — `hasNsfwWords` returns on the first hit and never says
    // which. Reported as such rather than backfilled with a guess.
    const matched = hasNsfwWords(name);
    return { matched, reason: matched ? 'nsfw-words' : 'no-match', matchedTerms: [] };
  }

  const analysis = getProfanityFilter().analyze(name);
  return {
    matched: analysis.isProfane,
    reason: analysis.isProfane ? `blocked-words:${analysis.matchCount}` : 'no-match',
    // `matches`, not `matchedWords`: the former is the LIST entry that fired, which is what you
    // subset a list by. The latter is the word as it appeared in the title.
    matchedTerms: analysis.matches,
  };
}

/** One XGuard text scan with no side effects: no EntityModeration row, no callback, no audit. */
async function scanWithXGuard(name: string): Promise<NonNullable<Verdict['xguard']>> {
  try {
    const result = await createXGuardModerationRequest({
      mode: 'text',
      content: name,
      labels: [...MODEL_MODERATION_SCAN_LABELS],
      wait,
      callbackUrl: null,
      recordForReview: false,
    });

    const steps = (result as { steps?: Array<Record<string, unknown>> })?.steps ?? [];
    const output = (steps.find((s) => s.$type === 'xGuardModeration') as { output?: unknown })
      ?.output as Parameters<typeof triggeredLabelKeys>[0];

    if (!output)
      return {
        triggeredLabels: [],
        labels: [],
        matchedTerms: [],
        levelScore: null,
        error: 'no xGuardModeration step in workflow output',
      };

    const triggered = triggeredLabelKeys(output, { includeScoreThreshold: true });
    const labels = triggeredLabelDetails(output, triggered);
    const levelScores = labels.filter((l) => LEVEL_LABELS.has(l.label)).map((l) => l.score);

    return {
      triggeredLabels: [...triggered],
      labels,
      matchedTerms: collectMatchedTerms(output, triggered),
      levelScore: levelScores.length ? Math.max(...levelScores) : null,
    };
  } catch (e) {
    // Returned rather than thrown: one unreachable orchestrator must not lose the other
    // several hundred verdicts in the batch, and an errored name is not a clean one.
    return {
      triggeredLabels: [],
      labels: [],
      matchedTerms: [],
      levelScore: null,
      error: (e as Error).message,
    };
  }
}

async function scanName(
  entry: Pick<Verdict, 'kind' | 'modelId' | 'versionId' | 'name'>
): Promise<Verdict> {
  const regex = scanner === 'xguard' ? null : matchTerms(entry.name);
  const xguard = scanner === 'regex' ? null : await scanWithXGuard(entry.name);
  return { ...entry, regex, xguard };
}

type Candidate = { id: number; name: string; lockedProperties: string[] };

async function selectCandidates(): Promise<{ candidates: Candidate[]; nextCursor: number | null }> {
  if (values['model-ids']) {
    const ids = values['model-ids']!.split(',').map((s) => Number(s.trim()));
    if (ids.some((id) => !Number.isInteger(id))) fail('--model-ids must be a comma-separated list');
    const rows = await dbRead.model.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, lockedProperties: true },
      orderBy: { id: 'asc' },
    });
    return {
      candidates: rows.map((r) => ({ ...r, lockedProperties: r.lockedProperties ?? [] })),
      nextCursor: null,
    };
  }

  const terms = values.all
    ? []
    : values
        .terms!.split(',')
        .map((t) => t.trim())
        .filter(Boolean);
  if (!values.all && (!terms.length || terms.length > 3))
    fail('--terms takes 1-3 comma-separated terms');

  const from = values.cursor ? Number(values.cursor) : 0;
  const to = from + Number(values.window);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer');
  const maxId = (await dbRead.model.aggregate({ _max: { id: true } }))._max.id ?? 0;

  // Name only, not name + description: this harness is about what renders as a title. Matching
  // the description would select models whose name is fine, which is the opposite of the point.
  //
  // `--all` drops the term filter entirely. A term-selected sample cannot measure a false
  // positive rate — every row in it already contains the term — so curating a list from one
  // tells you which terms fire and never what they fire on by mistake. This selector is the
  // denominator, and it is a plain indexed id range, so it is cheaper than the ILIKE it drops.
  const rows = await dbRead.model.findMany({
    where: {
      status: ModelStatus.Published,
      id: { gt: from, lte: to },
      ...(terms.length
        ? { OR: terms.map((term) => ({ name: { contains: term, mode: 'insensitive' as const } })) }
        : {}),
    },
    select: { id: true, name: true, lockedProperties: true },
    orderBy: { id: 'asc' },
    take: limit,
  });

  return {
    candidates: rows.map((r) => ({ ...r, lockedProperties: r.lockedProperties ?? [] })),
    nextCursor: resolveBackfillCursor({
      windowEnd: to,
      maxId,
      lastCandidateId: rows[rows.length - 1]?.id,
      truncated: rows.length === limit,
    }),
  };
}

/**
 * `limitConcurrency` resolves to void, so results are written into a pre-sized array by index
 * rather than collected from the return value. That also keeps the report in input order —
 * completion order would reshuffle the rows on every run and make two runs undiffable.
 */
async function scanAll(
  entries: Pick<Verdict, 'kind' | 'modelId' | 'versionId' | 'name'>[]
): Promise<Verdict[]> {
  const results = new Array<Verdict>(entries.length);
  await limitConcurrency(
    entries.map((entry, i) => async () => {
      results[i] = await scanName(entry);
    }),
    concurrency
  );
  return results;
}

async function main() {
  const verdicts: Verdict[] = [];
  let nextCursor: number | null = null;
  let candidates: Candidate[] = [];

  if (values.names) {
    verdicts.push(
      ...(await scanAll(
        values.names.map((name) => ({
          kind: 'model' as const,
          modelId: null,
          versionId: null,
          name,
        }))
      ))
    );
  } else {
    ({ candidates, nextCursor } = await selectCandidates());
    console.log(`selected ${candidates.length} model(s)`);

    const entries: Pick<Verdict, 'kind' | 'modelId' | 'versionId' | 'name'>[] = candidates.map(
      (m) => ({ kind: 'model', modelId: m.id, versionId: null, name: m.name })
    );

    if (scanVersions && candidates.length) {
      const versions = await dbRead.modelVersion.findMany({
        where: { modelId: { in: candidates.map((m) => m.id) }, status: ModelStatus.Published },
        select: { id: true, modelId: true, name: true },
        orderBy: { id: 'asc' },
      });
      entries.push(
        ...versions.map((v) => ({
          kind: 'version' as const,
          modelId: v.modelId,
          versionId: v.id,
          name: v.name,
        }))
      );
      console.log(`+ ${versions.length} published version name(s)`);
    }

    verdicts.push(...(await scanAll(entries)));
  }

  const flagged = verdicts.filter(
    (v) => v.regex?.matched || v.xguard?.triggeredLabels.some((l) => LEVEL_LABELS.has(l))
  );

  console.log('');
  for (const v of flagged) {
    const who = v.versionId ? `v${v.versionId}` : v.modelId ? `m${v.modelId}` : '-';
    const rx = v.regex
      ? v.regex.matched
        ? `regex[${v.regex.matchedTerms.join(',')}]`
        : 'regex-'
      : '';
    const xg = v.xguard
      ? v.xguard.error
        ? `xguard-ERR(${v.xguard.error})`
        : v.xguard.labels
            .filter((l) => LEVEL_LABELS.has(l.label))
            .map((l) => `${l.label}=${l.score.toFixed(2)}/${l.threshold.toFixed(2)}`)
            .join(' ') || 'xguard-'
      : '';
    console.log(`${who}\t${v.kind}\t${rx} ${xg}\t${v.name}`);
  }

  const errored = verdicts.filter((v) => v.xguard?.error).length;
  const agree =
    scanner === 'both'
      ? verdicts.filter(
          (v) => !!v.regex?.matched === !!v.xguard?.triggeredLabels.some((l) => LEVEL_LABELS.has(l))
        ).length
      : null;

  // Per-term hit counts. Picking "the most egregious terms" out of a 391-word list is a
  // judgement about which terms fire on titles and on what, and this is the only output that
  // shows it — a total flagged count says nothing about which term earned its place.
  const termHits = new Map<string, number>();
  for (const v of verdicts)
    for (const term of v.regex?.matchedTerms ?? [])
      termHits.set(term, (termHits.get(term) ?? 0) + 1);
  if (termHits.size) {
    console.log('');
    console.log('term hits (descending):');
    for (const [term, n] of [...termHits].sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(4)}  ${term}`);
  }

  console.log('');
  console.log({
    scanned: verdicts.length,
    models: verdicts.filter((v) => v.kind === 'model').length,
    versions: verdicts.filter((v) => v.kind === 'version').length,
    flagged: flagged.length,
    // Counted, not folded into `flagged`: a scan that errored looks exactly like a clean one
    // in every other column, and a batch that silently half-failed reads as a low trigger rate.
    xguardErrors: errored,
    ...(agree !== null
      ? { detectorsAgree: agree, detectorsDisagree: verdicts.length - agree }
      : {}),
    nextCursor,
  });

  if (values.out) {
    const { writeFileSync } = await import('fs');
    writeFileSync(values.out, JSON.stringify(verdicts, null, 2));
    console.log(`wrote ${values.out}`);
  }

  if (values['record-versions']) {
    const byModel = new Map<number, { versionId: number; name: string; labels: LabelDetail[] }[]>();
    for (const v of verdicts) {
      if (v.kind !== 'version' || !v.modelId || !v.versionId) continue;
      if (!v.xguard?.triggeredLabels.length) continue;
      const list = byModel.get(v.modelId) ?? [];
      list.push({ versionId: v.versionId, name: v.name, labels: v.xguard.labels });
      byModel.set(v.modelId, list);
    }
    await limitConcurrency(
      [...byModel].map(
        ([modelId, versions]) =>
          () =>
            recordModelVersionNameForensics({ modelId, versions })
      ),
      concurrency
    );
    console.log(`recorded version findings on ${byModel.size} model(s)`);
  }

  if (values.apply) {
    const locked = new Set(
      candidates.filter((c) => c.lockedProperties.includes('nsfw')).map((c) => c.id)
    );
    const targets = verdicts.filter(
      (v) =>
        v.kind === 'model' &&
        v.modelId !== null &&
        !locked.has(v.modelId) &&
        v.xguard?.levelScore !== null &&
        v.xguard!.levelScore! >= minScore!
    );

    const outcomes: Record<string, number> = {};
    await limitConcurrency(
      targets.map(
        (v) => () =>
          applyModelTextNsfwFlag({
            entityId: v.modelId!,
            triggeredLabels: v.xguard!.triggeredLabels,
            matchedTerms: v.xguard!.matchedTerms,
            labels: v.xguard!.labels,
            source: HARNESS_SOURCE,
          }).then((outcome) => {
            outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
          })
      ),
      concurrency
    );
    console.log({ applyMinScore: minScore, targets: targets.length, outcomes });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
