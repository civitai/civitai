/**
 * One-shot cleanup for ModelVersion.baseModel values that are not in the canonical list.
 *
 * Actions:
 *   POST/GET ?token=$WEBHOOK_TOKEN
 *     dryRun    boolean, default true. Report what would change without writing.
 *
 * Not a migration: search holds its own copy of `baseModel`, so a plain UPDATE leaves the stray
 * still offered as a filter option until the affected models are reindexed.
 */
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { bustMvCache } from '~/server/services/model-version.service';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';

const log = createLogger('fix-stray-base-models', 'blue');

/** Strays whose canonical target is the same for every row carrying them. */
const BY_VALUE: Record<string, string> = {
  'ACE-Step': 'ACE Audio',
  ANIMA: 'Anima',
  'Illustrious 0.1': 'Illustrious',
  Krea2: 'Krea 2',
  'LTX Video': 'LTXV 2.5',
  'Z-Image': 'ZImageTurbo',
  __bad__: 'Illustrious',
};

/**
 * `Flux 1.0` covers two different things, so it resolves per row. The nine versions split cleanly
 * into a 332,786 KB group titled "SDXL LoRA" and a 299,248 KB group titled "Flux LoRA" — title and
 * file size agree on every row, which is what makes the split safe to hard-code.
 */
const BY_ID: Record<number, string> = {
  3130525: 'SDXL 1.0',
  3130527: 'SDXL 1.0',
  3130529: 'SDXL 1.0',
  3151065: 'Flux.1 D',
  3157727: 'Flux.1 D',
  3157731: 'Flux.1 D',
  3157732: 'Flux.1 D',
  3200682: 'Flux.1 D',
  3200684: 'Flux.1 D',
};

const querySchema = z.object({ dryRun: booleanString().default(true) });

const canonical = new Set(baseModels);

export default WebhookEndpoint(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ ok: false, error: z.treeifyError(parsed.error) });
  const { dryRun } = parsed.data;

  const offTarget = Object.values(BY_VALUE)
    .concat(Object.values(BY_ID))
    .filter((name) => !canonical.has(name));
  if (offTarget.length)
    return res.status(500).json({ ok: false, error: `targets not canonical: ${offTarget}` });

  // Selected by "not canonical" rather than by the map's own keys, so a stray that appeared after
  // this file was written shows up under `unresolved` instead of being silently skipped.
  const rows = await dbWrite.modelVersion.findMany({
    where: { baseModel: { notIn: baseModels } },
    select: { id: true, modelId: true, baseModel: true },
  });

  const planned = rows.flatMap((row) => {
    const to = BY_ID[row.id] ?? BY_VALUE[row.baseModel];
    return to ? [{ ...row, to }] : [];
  });

  const unresolved = rows.filter((row) => !BY_ID[row.id] && !BY_VALUE[row.baseModel]);

  if (!dryRun && planned.length) {
    const byTarget = new Map<string, number[]>();
    for (const { id, to } of planned) byTarget.set(to, [...(byTarget.get(to) ?? []), id]);
    await dbWrite.$transaction(
      [...byTarget].map(([baseModel, ids]) =>
        dbWrite.modelVersion.updateMany({ where: { id: { in: ids } }, data: { baseModel } })
      )
    );

    const modelIds = [...new Set(planned.map((p) => p.modelId))];
    // Passing modelIds is what queues the search reindex and drops the public model response cache.
    await bustMvCache(
      planned.map((p) => p.id),
      modelIds
    );
    log(`updated ${planned.length} versions across ${modelIds.length} models`);
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    changed: planned.length,
    models: new Set(planned.map((p) => p.modelId)).size,
    changes: planned.map(({ id, baseModel, to }) => ({ id, from: baseModel, to })),
    unresolved: unresolved.map(({ id, baseModel }) => ({ id, baseModel })),
  });
});
