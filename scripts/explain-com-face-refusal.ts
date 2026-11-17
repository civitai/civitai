import { parseArgs } from 'util';

import { dbRead } from '~/server/db/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { previewComFaceIntent, previewTextScanNsfw } from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';
import { removeTags } from '~/utils/string-helpers';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Explain why a model is (or is not) refused a civitai.com face.
 *
 *   pnpm run tsscript scripts/explain-com-face-refusal.ts --model <id> [--model <id> ...]
 *
 * For each model it prints:
 *   - the stored state: whether it has a .com title and cover, and the re-check's removal marker
 *     (`meta.comFaceRemoved`), which keeps the refusal banner on the edit page until the owner saves
 *     a new .com cover;
 *   - the listing intent check exactly as the save gate and the re-check run it (`checkComFaceIntent`:
 *     the .red title, description and every version's trigger words, as one request), with the
 *     check's own reason;
 *   - the same check on each part alone (title, description, each version's trigger words), so the
 *     part that drives a refusal is visible;
 *   - the rating of the stored .com title and description (`checkSfwFace`'s second gate).
 *
 * Read-only: Postgres through `dbRead`, and text-scan previews, which register no callback, name no
 * entity and write no moderation record. Images are never read. The checks' prompts and settings are
 * read from the database at run time and are not printed.
 */

const WAIT_SECONDS = 30;

type IntentResult = { detected: boolean; reason: string } | 'unavailable';

async function intent(fields: TextScanField[]): Promise<IntentResult> {
  const verdict = await previewComFaceIntent({ fields, waitSeconds: WAIT_SECONDS }).catch(() => ({
    status: 'unavailable' as const,
  }));
  return verdict.status === 'ok' ? verdict.output : 'unavailable';
}

function show(label: string, result: IntentResult) {
  if (result === 'unavailable') return console.log(`  ${label}: UNAVAILABLE (no verdict)`);
  console.log(`  ${label}: ${result.detected ? 'DETECTED' : 'allowed'} — ${result.reason}`);
}

async function explain(modelId: number) {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      sfwName: true,
      sfwDescription: true,
      sfwCoverImageId: true,
      nsfw: true,
      deletedAt: true,
      meta: true,
      modelVersions: {
        select: { id: true, name: true, trainedWords: true },
        orderBy: { index: 'asc' },
      },
    },
  });
  console.log(`\n=== model ${modelId} ===`);
  if (!model) return console.log('  not found');

  const marker = (model.meta as ModelMeta | null)?.comFaceRemoved;
  console.log(
    `  state: deleted=${!!model.deletedAt} nsfw=${model.nsfw} comTitle=${!!model.sfwName} ` +
      `comCover=${model.sfwCoverImageId ?? 'none'}`
  );
  console.log(
    marker
      ? `  removal marker: at ${marker.at}, reason ${marker.reason}, cover ${marker.sfwCoverImageId} ` +
          '(the edit page shows the refusal banner until a new .com cover is saved)'
      : '  removal marker: none'
  );

  // Mirrors checkComFaceIntent; trigger words are the owner's own versions' (getOwnTriggerWords).
  const description = removeTags(model.description ?? '').trim();
  const triggerWords = [...new Set(model.modelVersions.flatMap((v) => v.trainedWords))];
  const nameField: TextScanField = { heading: 'Name', text: model.name };
  const descField: TextScanField | null = description
    ? { heading: 'Description', text: description }
    : null;
  const wordsField = (words: string[]): TextScanField => ({
    heading: 'Trained words',
    text: words.join(', '),
  });
  const full: TextScanField[] = [
    nameField,
    ...(descField ? [descField] : []),
    ...(triggerWords.length ? [wordsField(triggerWords)] : []),
  ];

  const parts: [string, Promise<IntentResult>][] = [
    ['GATE (title + description + trigger words)', intent(full)],
    ['title alone', intent([nameField])],
    ...(descField
      ? ([['description alone', intent([descField])]] as [string, Promise<IntentResult>][])
      : []),
    ...model.modelVersions
      .filter((v) => v.trainedWords.length)
      .map(
        (v) =>
          [`trigger words of version ${v.id} alone`, intent([wordsField(v.trainedWords)])] as [
            string,
            Promise<IntentResult>
          ]
      ),
  ];
  console.log(
    `  intent check (description ${description.length} chars, ${triggerWords.length} trigger words):`
  );
  for (const [label, result] of parts) show(label, await result);

  if (model.sfwName) {
    const sfwText = removeTags(model.sfwDescription ?? '').trim();
    const rating = await previewTextScanNsfw({
      fields: [
        { heading: 'Name', text: model.sfwName },
        ...(sfwText ? [{ heading: 'Description', text: sfwText }] : []),
      ],
      waitSeconds: WAIT_SECONDS,
    }).catch(() => ({ status: 'unavailable' as const }));
    console.log(
      rating.status === 'ok'
        ? `  stored .com title+description rating: level ${rating.level} — ${rating.reason}`
        : '  stored .com title+description rating: UNAVAILABLE'
    );
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { model: { type: 'string', multiple: true } },
  });
  const ids = (values.model ?? []).map(Number);
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0))
    throw new Error('Pass one or more --model <positive integer id>');
  for (const id of ids) await explain(id);
}

if (process.argv[1]?.endsWith('explain-com-face-refusal.ts')) {
  void runScriptAndExit(() => main());
}
