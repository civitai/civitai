/**
 * The A2 eval report: human baseline, per-arm disagreement in both directions, precision when
 * disagreeing, approved-appeal over-representation, and the A4 promotion verdict.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/report.ts \
 *     --run <run_id> --thresholds <private.json> [--rows-out <private.jsonl>]
 *
 * Read-only. Prints counts only, so the output can be pasted into the ticket. `--rows-out` writes
 * the per-item rows A5 consumes; they carry image ids, so write them somewhere private.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import {
  disagreementRows,
  humanAgreement,
  signalsArmPromoted,
  summarise,
  type HumanLabel,
  type Prediction,
  type ReportItem,
  type Thresholds,
} from '../src/lib/removal-label/report';
import { isMinorBucket } from '../src/lib/removal-label/sampling';
import { answersFromRow } from '../src/lib/removal-label/questions';

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(1)}%` : 'n/a');

async function main() {
  const argv = process.argv.slice(2);
  const runId = arg(argv, '--run');
  const thresholdsPath = arg(argv, '--thresholds');
  if (!runId || !thresholdsPath) throw new Error('--run and --thresholds are required');
  const thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf8')) as Thresholds;

  const mod = new pg.Client({ connectionString: requireEnv('MODERATOR_DATABASE_URL') });
  await mod.connect();
  let items: ReportItem[];
  let labels: HumanLabel[];
  let predictions: Prediction[];
  try {
    const itemRows = await mod.query<{
      id: string;
      image_id: number;
      stratum: 'removed' | 'not_removed';
      bucket: string | null;
    }>('SELECT id::text, image_id, stratum, bucket FROM relabel_item');
    items = itemRows.rows.map((r) => ({
      itemId: r.id,
      imageId: r.image_id,
      stratum: r.stratum,
      bucket: isMinorBucket(r.bucket) ? r.bucket : null,
      appealStatus: null,
    }));
    const answerRows = await mod.query<{
      item_id: string;
      labeler_id: number;
      minor_present: string;
      sexual_level: string;
      violence: string;
      school_setting: string;
    }>(
      'SELECT item_id::text, labeler_id, minor_present, sexual_level, violence, school_setting FROM relabel_answer'
    );
    // A stored value that is no longer a valid option drops the label rather than passing as one.
    labels = answerRows.rows.flatMap((r) => {
      const answers = answersFromRow(r);
      return answers ? [{ itemId: r.item_id, labelerId: r.labeler_id, answers }] : [];
    });
    const dropped = answerRows.rows.length - labels.length;
    if (dropped) console.warn(`${dropped} stored answers carry retired option values; ignored`);
    const predRows = await mod.query<{
      item_id: string;
      arm: Prediction['arm'];
      answers: Prediction['answers'];
    }>('SELECT item_id::text, arm, answers FROM relabel_prediction WHERE run_id = $1', [runId]);
    predictions = predRows.rows.map((r) => ({ itemId: r.item_id, arm: r.arm, answers: r.answers }));
  } finally {
    await mod.end();
  }

  // Appeal outcome as of now, not as of sampling: most were still pending when the item was drawn.
  const replica = new pg.Client({ connectionString: requireEnv('DATABASE_REPLICA_URL') });
  await replica.connect();
  try {
    const removedIds = items.filter((i) => i.stratum === 'removed').map((i) => i.imageId);
    const { rows } = await replica.query<{ entityId: number; status: string }>(
      `SELECT DISTINCT ON ("entityId") "entityId", status::text AS status
       FROM "Appeal" WHERE "entityType" = 'Image' AND "entityId" = ANY($1::int[])
       ORDER BY "entityId", "createdAt" DESC`,
      [removedIds]
    );
    const status = new Map(rows.map((r) => [r.entityId, r.status]));
    for (const i of items) i.appealStatus = status.get(i.imageId) ?? null;
  } finally {
    await replica.end();
  }

  const human = humanAgreement(labels);
  console.log(`## Removal-label pilot, run ${runId}\n`);
  console.log(
    `Items: ${items.length} (removed ${
      items.filter((i) => i.stratum === 'removed').length
    }, not removed ${items.filter((i) => i.stratum === 'not_removed').length})\n`
  );
  console.log('### Human baseline (two blind labelers)\n');
  for (const [q, h] of Object.entries(human))
    console.log(
      `- ${q}: agree ${h.agree}/${h.of} (${pct(h.agree, h.of)}), kappa ${
        h.kappa?.toFixed(2) ?? 'n/a'
      }`
    );

  const summaries = summarise(items, labels, predictions, thresholds);
  for (const s of summaries) {
    console.log(`\n### Arm: ${s.arm}\n`);
    console.log(
      `- Predictions ${s.predictions}, with a proposal ${s.covered} (${pct(
        s.covered,
        s.predictions
      )})`
    );
    console.log(`- Removed, model disagrees: ${JSON.stringify(s.removedDisagreeing)}`);
    console.log(`- Not removed, model flags: ${JSON.stringify(s.notRemovedFlagging)}`);
    console.log(
      `- Right when disagreeing (vs relabel gold): ${s.disagreeingRight}/${
        s.disagreeingWithGold
      } (${pct(s.disagreeingRight, s.disagreeingWithGold)}), Wilson lower ${
        s.disagreeingRightLower?.toFixed(2) ?? 'n/a'
      }; bar 80%`
    );
    console.log(`- Minor recall on gold-minor items: ${s.minorRecall.hit}/${s.minorRecall.of}`);
    const a = s.appeals;
    console.log(
      `- Approved appeals: disagreeing ${a.disagreeApproved}/${a.disagreeResolved} (${pct(
        a.disagreeApproved,
        a.disagreeResolved
      )}), agreeing ${a.agreeApproved}/${a.agreeResolved} (${pct(
        a.agreeApproved,
        a.agreeResolved
      )})`
    );
  }

  const image = summaries.find((s) => s.arm === 'image');
  const signals = summaries.find((s) => s.arm === 'image_signals');
  if (image && signals)
    console.log(
      `\n### A4 verdict\n\nimage+signals ${
        signalsArmPromoted(image, signals) ? 'PROMOTED' : 'not promoted'
      } over image-only (needs higher precision when disagreeing and no loss of minor recall).`
    );

  const rowsOut = arg(argv, '--rows-out');
  if (rowsOut) {
    const rows = disagreementRows(items, labels, predictions, thresholds);
    writeFileSync(rowsOut, rows.map((r) => JSON.stringify({ runId, ...r })).join('\n') + '\n');
    console.log(`\n${rows.length} per-item rows written to ${rowsOut}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
