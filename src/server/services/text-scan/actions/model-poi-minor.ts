import { Prisma } from '@prisma/client';
import { Tracker } from '~/server/clickhouse/tracker';
import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { createNotification } from '~/server/services/notification.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { carriedRulings, flagEntryPath, labelLiteral } from '~/server/services/text-scan/flag-sql';
import {
  writeTextScanRuling,
  type TextScanModelRuling,
} from '~/server/services/text-scan/label-capture';
import {
  appealGrantCoversText,
  buildTextScanFlagEntry,
  readTextScanFlags,
  TEXT_SCAN_FLAGS_KEY,
  type HeldDetectionKind,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import {
  getTextScanLabelMode,
  textScanEmEntityType,
  type TextScanLabelMode,
} from '~/server/services/text-scan/mode';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { ModelStatus } from '~/shared/utils/prisma/enums';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

export const POI_LOCKED_PROPERTIES = ['poi', 'nsfw', 'sfwOnly'];

export type PoiMinorResult = { notified: boolean };

const SYSTEM_USER_ID = constants.system.user.id;

// The live rows that can act on poi/minor: the main pass, and the web-search pass once active.
// The one whose workflow produced this verdict wins; 'Model' sorts first otherwise.
const VERDICT_ROW_TYPES = [
  textScanEmEntityType('Model', 'active'),
  textScanEmEntityType('Model', 'active', 'web-search'),
];

// Dynamic: model.service imports the model moderation adapter, which imports this module.
const loadModelService = () => import('~/server/services/model.service');

type ModelFlagRow = {
  id: number;
  name: string;
  description: string | null;
  userId: number;
  poi: boolean;
  nsfw: boolean;
  minor: boolean;
  sfwOnly: boolean;
  status: ModelStatus;
  gallerySettings: Prisma.JsonValue;
  lockedProperties: string[];
};

// 'skip': nothing to do. 'redetect': a human already cleared this label on other text, so the
// detection waits for a moderator instead of re-flagging over their ruling. 'review': no ruling
// exists, but the label is in review mode, so the first detection waits for a moderator too.
function classifyDetection(
  label: TextScanFlagLabel,
  model: { meta: Prisma.JsonValue; lockedProperties: string[] },
  textHash: string,
  labelMode: TextScanLabelMode
): 'skip' | 'flag' | 'redetect' | 'review' {
  if (!readTextScanFlags(model.meta)[label]?.appealGranted) {
    if (model.lockedProperties.includes(label)) return 'skip';
    return labelMode === 'review' ? 'review' : 'flag';
  }
  return appealGrantCoversText(model.meta, label, textHash) ? 'skip' : 'redetect';
}

const labelColumn = (label: TextScanFlagLabel) => Prisma.raw(`m.${label}`);

// promptIds / model of the scan row whose workflow produced the verdict.
const verdictRowField = (field: 'promptIds' | 'model', workflowId: string) => Prisma.sql`(
  SELECT em.result->${Prisma.raw(`'${field}'`)} FROM "EntityModeration" em
  WHERE em."entityType" = ANY(${VERDICT_ROW_TYPES}::text[]) AND em."entityId" = m.id
  ORDER BY em."workflowId" = ${workflowId} DESC NULLS LAST, em."entityType" LIMIT 1)`;

// The scan flags only past a clean slate. A moderator keeping a re-detection flags over the
// grant, but only for the text the moderator was shown, and never for the text the grant covers.
// Resuming a keep whose side effects failed skips this guard: that flag write already happened.
const flagGuard = (label: TextScanFlagLabel, keptHash: string | null) =>
  keptHash
    ? Prisma.sql`${flagEntryPath(label)}->'redetected'->>'textHash' = ${keptHash}
        AND ${flagEntryPath(label)}->'appealGranted'->>'textHash' IS DISTINCT FROM ${keptHash}`
    : Prisma.sql`${flagEntryPath(label)}->'appealGranted' IS NULL
        AND NOT (${labelLiteral(label)} = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))`;

// The flag a moderator keeps carries the marker until the whole keep has landed (the caller drops it
// last), so a failure leaves the item in the queue and a retry finishes it.
const keptMarker = (label: TextScanFlagLabel, kept: boolean) =>
  kept
    ? Prisma.sql`jsonb_build_object('redetected', ${flagEntryPath(label)}->'redetected')`
    : Prisma.sql`'{}'::jsonb`;

/** Drops the marker for exactly the text the moderator ruled on. */
export async function dropRedetection({
  modelId,
  label,
  textHash,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  textHash: string;
}) {
  return redetectionUpdate({ modelId, label, textHash, match: 'equal' });
}

/** Drops a marker for text other than the one just scanned: the owner has moved on from it. */
export function clearSupersededRedetection({
  modelId,
  label,
  textHash,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  textHash: string;
}) {
  return redetectionUpdate({ modelId, label, textHash, match: 'distinct' });
}

async function redetectionUpdate({
  modelId,
  label,
  textHash,
  match,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  textHash: string;
  match: 'equal' | 'distinct';
}) {
  const entry = flagEntryPath(label);
  const compare = match === 'equal' ? Prisma.sql`=` : Prisma.sql`IS DISTINCT FROM`;
  const changed = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = CASE
      -- Nothing else on the entry: remove it (and the flags object with it) rather than leave {}.
      WHEN ${entry} - 'redetected' = '{}'::jsonb THEN
        CASE WHEN (m.meta->${TEXT_SCAN_FLAGS_KEY}) - ${labelLiteral(label)} = '{}'::jsonb
          THEN m.meta - ${TEXT_SCAN_FLAGS_KEY}
          ELSE m.meta || jsonb_build_object(
            ${TEXT_SCAN_FLAGS_KEY}, (m.meta->${TEXT_SCAN_FLAGS_KEY}) - ${labelLiteral(label)}
          )
        END
      ELSE m.meta || jsonb_build_object(
        ${TEXT_SCAN_FLAGS_KEY}, m.meta->${TEXT_SCAN_FLAGS_KEY} || jsonb_build_object(
          ${labelLiteral(label)}, ${entry} - 'redetected'
        )
      )
    END
    WHERE m.id = ${modelId}
      AND ${entry} ? 'redetected'
      AND ${entry}->'redetected'->>'textHash' ${compare} ${textHash}
  `;
  return changed > 0;
}

// The owner is back on text the grant covers: a marker for other text is stale. Read from the meta
// the caller already holds, so the common case costs nothing.
async function dropStaleMarker({
  modelId,
  label,
  meta,
  textHash,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  meta: Prisma.JsonValue;
  textHash: string;
}) {
  const marker = readTextScanFlags(meta)[label]?.redetected;
  if (marker && marker.textHash !== textHash)
    await clearSupersededRedetection({ modelId, label, textHash });
}

export type FlagResult = { written: boolean; notified: boolean; redetected?: boolean };
const NOT_FLAGGED: FlagResult = { written: false, notified: false };

/** Set when a moderator keeps a re-detection: the flag lands over the grant and is theirs. */
export type KeptRedetection = {
  userId: number;
  /** The flag is already written by an earlier attempt of this same keep: finish what it did not. */
  resume?: boolean;
};

// Both kinds are stored under `redetected`: the moderator queue's partial index is keyed on it.
async function recordHold({
  modelId,
  label,
  workflowId,
  reason,
  names,
  textHash,
  kind,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  workflowId: string;
  reason: string;
  names?: string[];
  textHash: string;
  kind: HeldDetectionKind;
}) {
  const detection = JSON.stringify(buildTextScanFlagEntry({ workflowId, reason, names, textHash }));
  const write = async (heldKind: HeldDetectionKind) => {
    const guard =
      heldKind === 'first'
        ? // The same text held again keeps its place in the queue.
          Prisma.sql`${flagEntryPath(label)}->'appealGranted' IS NULL
          AND NOT (${labelLiteral(label)} = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
          AND ${flagEntryPath(label)}->'redetected'->>'textHash' IS DISTINCT FROM ${textHash}`
        : Prisma.sql`${flagEntryPath(label)}->'appealGranted' IS NOT NULL
          AND ${flagEntryPath(label)}->'appealGranted'->>'textHash' IS DISTINCT FROM ${textHash}`;
    return dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        ${labelLiteral(label)}, COALESCE(${flagEntryPath(
      label
    )}, '{}'::jsonb) || jsonb_build_object(
          'redetected', ${detection}::jsonb || jsonb_build_object(
            'kind', ${heldKind}::text,
            'at', now(),
            'promptIds', ${verdictRowField('promptIds', workflowId)},
            'model', ${verdictRowField('model', workflowId)}
          )
        )
      )
    )
    WHERE m.id = ${modelId}
      AND NOT ${labelColumn(label)}
      AND ${guard}
  `;
  };
  let heldKind = kind;
  let written = await write(heldKind);
  // A moderator ruling on the old text can land between the scan's read and this write: the label then
  // has a grant, and the same detection is a re-detection of it.
  if (!written && kind === 'first') {
    heldKind = 'redetected';
    written = await write(heldKind);
  }
  if (written)
    logToAxiom({
      name: 'text-scan',
      type: 'info',
      message:
        heldKind === 'first'
          ? `${label} first detection held, awaiting moderator`
          : `${label} re-detected after a human clear, awaiting moderator`,
      entityType: 'Model',
      entityId: modelId,
      workflowId,
    }).catch(() => null);
  return written > 0;
}

export async function applyModelPoiMinor({
  entityId,
  workflowId,
  outcome,
  textHash,
}: ApplyTextScanArgs): Promise<PoiMinorResult> {
  let notified = false;
  // A clean verdict from the pass that owns the label ends a re-detection of other text. No read:
  // the statement matches nothing for the near-universal model without one.
  for (const label of ['poi', 'minor'] as const)
    if (outcome[label] && !outcome[label]!.detected)
      await clearSupersededRedetection({ modelId: entityId, label, textHash });
  if (outcome.poi?.newlyDetected)
    notified =
      (
        await flagModelPoi({
          modelId: entityId,
          workflowId,
          reason: outcome.poi.reason,
          names: outcome.poi.names,
          textHash,
        })
      ).notified || notified;
  if (outcome.minor?.newlyDetected)
    notified =
      (
        await flagModelMinor({
          modelId: entityId,
          workflowId,
          reason: outcome.minor.reason,
          textHash,
        })
      ).notified || notified;
  return { notified };
}

// A keep that died after the flag UPDATE left `poi` set but its side effects undone. The pre-flag
// state the side effects diff against is the snapshot the flag write recorded on the entry.
async function resumedPoi(modelId: number, meta: Prisma.JsonValue) {
  const after = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      name: true,
      description: true,
      userId: true,
      poi: true,
      nsfw: true,
      minor: true,
      sfwOnly: true,
      status: true,
      gallerySettings: true,
      lockedProperties: true,
    },
  });
  if (!after) throw new Error(`Model ${modelId} vanished while resuming its poi flag`);
  const prev = readTextScanFlags(meta).poi?.prev;
  const gallery = (after.gallerySettings ?? {}) as Record<string, unknown>;
  const prior = {
    userId: after.userId,
    poi: false,
    minor: after.minor,
    name: after.name,
    nsfw: prev?.nsfw ?? after.nsfw,
    sfwOnly: prev?.sfwOnly ?? after.sfwOnly,
    gallerySettings: (prev
      ? { ...gallery, level: prev.galleryLevel ?? undefined }
      : after.gallerySettings) as Prisma.JsonValue,
    lockedProperties: prev?.lockedProperties ?? after.lockedProperties,
    meta,
  };
  return { prior, after: after as ModelFlagRow };
}

export async function flagModelPoi({
  modelId,
  workflowId,
  reason,
  names,
  textHash,
  kept,
}: {
  modelId: number;
  workflowId: string;
  reason: string;
  names: string[];
  textHash: string;
  kept?: KeptRedetection;
}): Promise<FlagResult> {
  const before = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      userId: true,
      name: true,
      poi: true,
      minor: true,
      nsfw: true,
      sfwOnly: true,
      gallerySettings: true,
      lockedProperties: true,
      meta: true,
    },
  });
  if (!before || (before.poi && !kept?.resume)) return NOT_FLAGGED;
  if (!kept) {
    const action = classifyDetection('poi', before, textHash, await getTextScanLabelMode('poi'));
    if (action === 'skip') {
      await dropStaleMarker({ modelId, label: 'poi', meta: before.meta, textHash });
      return NOT_FLAGGED;
    }
    if (action === 'redetect' || action === 'review')
      return {
        ...NOT_FLAGGED,
        redetected: await recordHold({
          modelId,
          label: 'poi',
          workflowId,
          reason,
          names,
          textHash,
          kind: action === 'review' ? 'first' : 'redetected',
        }),
      };
  }

  const entry = JSON.stringify(buildTextScanFlagEntry({ workflowId, reason, names, textHash }));
  let prior = before;
  let after: ModelFlagRow | undefined;
  if (kept?.resume) ({ prior, after } = await resumedPoi(modelId, before.meta));
  else
    [after] = await dbWrite.$queryRaw<ModelFlagRow[]>`
    UPDATE "Model" m
    SET poi = TRUE,
        nsfw = FALSE,
        "sfwOnly" = TRUE,
        "gallerySettings" = COALESCE(m."gallerySettings", '{}'::jsonb)
          || jsonb_build_object('level', ${sfwBrowsingLevelsFlag}::int),
        "lockedProperties" = ARRAY(
          SELECT DISTINCT unnest(COALESCE(m."lockedProperties", ARRAY[]::text[]) || ${POI_LOCKED_PROPERTIES}::text[])
        ),
        meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
          ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
            'poi', ${entry}::jsonb || ${carriedRulings('poi')} || ${keptMarker(
      'poi',
      !!kept
    )} || jsonb_build_object(
              'at', now(),
              'promptIds', ${verdictRowField('promptIds', workflowId)},
              'model', ${verdictRowField('model', workflowId)},
              'prev', jsonb_build_object(
                'nsfw', m.nsfw,
                'sfwOnly', m."sfwOnly",
                'galleryLevel', (m."gallerySettings"->>'level')::int,
                'lockedProperties', to_jsonb(COALESCE(m."lockedProperties", ARRAY[]::text[]))
              )
            )
          )
        )
    WHERE m.id = ${modelId}
      AND NOT m.poi
      AND ${flagGuard('poi', kept ? textHash : null)}
    RETURNING m.id, m.name, m.description, m."userId", m.poi, m.nsfw, m.minor, m."sfwOnly",
              m.status, m."gallerySettings", m."lockedProperties"
  `;
  if (!after) return NOT_FLAGGED;

  const { applyModelFlagSideEffects } = await loadModelService();
  await applyModelFlagSideEffects({ before: prior, after });
  if (prior.nsfw) await updateModelNsfwLevels([modelId]);
  await bustPublicModelResponseCache(modelId);

  await new Tracker()
    .entityChanges(
      diffEntityChanges({
        entityType: 'Model',
        entityId: modelId,
        ownerId: prior.userId,
        before: {
          poi: prior.poi,
          nsfw: prior.nsfw,
          sfwOnly: prior.sfwOnly,
          lockedProperties: prior.lockedProperties,
        },
        after: {
          poi: after.poi,
          nsfw: after.nsfw,
          sfwOnly: after.sfwOnly,
          lockedProperties: after.lockedProperties,
        },
        actorRole: kept ? 'moderator' : 'system',
        ...(kept
          ? { reason: 'textScanRedetectionKept' }
          : {
              systemFields: {
                poi: 'text-scan',
                nsfw: 'text-scan',
                sfwOnly: 'text-scan',
                lockedProperties: 'text-scan',
              },
            }),
      })
    )
    .catch(() => null);

  const notified = await notifyModelOwner({
    modelId,
    modelName: after.name,
    userId: after.userId,
    label: 'poi',
    workflowId,
  });
  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'poi flag applied',
    entityType: 'Model',
    entityId: modelId,
    workflowId,
  }).catch(() => null);
  return { written: true, notified };
}

export async function flagModelMinor({
  modelId,
  workflowId,
  reason,
  textHash,
  kept,
}: {
  modelId: number;
  workflowId: string;
  reason: string;
  textHash: string;
  kept?: KeptRedetection;
}): Promise<FlagResult> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { userId: true, name: true, minor: true, lockedProperties: true, meta: true },
  });
  if (!model || (model.minor && !kept?.resume)) return NOT_FLAGGED;
  if (!kept) {
    const action = classifyDetection('minor', model, textHash, await getTextScanLabelMode('minor'));
    if (action === 'skip') {
      await dropStaleMarker({ modelId, label: 'minor', meta: model.meta, textHash });
      return NOT_FLAGGED;
    }
    if (action === 'redetect' || action === 'review')
      return {
        ...NOT_FLAGGED,
        redetected: await recordHold({
          modelId,
          label: 'minor',
          workflowId,
          reason,
          textHash,
          kind: action === 'review' ? 'first' : 'redetected',
        }),
      };
  }

  const entry = JSON.stringify(buildTextScanFlagEntry({ workflowId, reason, textHash }));
  // A resumed keep already wrote the entry; only setModelMinor's work onwards is outstanding.
  const written = kept?.resume
    ? 1
    : await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        'minor', ${entry}::jsonb || ${carriedRulings('minor')} || ${keptMarker(
        'minor',
        !!kept
      )} || jsonb_build_object(
          'at', now(),
          'promptIds', ${verdictRowField('promptIds', workflowId)},
          'model', ${verdictRowField('model', workflowId)}
        )
      )
    )
    WHERE m.id = ${modelId}
      AND NOT m.minor
      AND ${flagGuard('minor', kept ? textHash : null)}
  `;
  if (!written) return NOT_FLAGGED;

  const { setModelMinor } = await loadModelService();
  await setModelMinor({
    id: modelId,
    minor: true,
    userId: kept?.userId ?? SYSTEM_USER_ID,
    activity: 'setMinorTextScan',
    ...(kept && { isModerator: true }),
    ...(kept?.resume && { reapplySideEffects: true }),
  });

  const notified = await notifyModelOwner({
    modelId,
    modelName: model.name,
    userId: model.userId,
    label: 'minor',
    workflowId,
  });
  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'minor flag applied',
    entityType: 'Model',
    entityId: modelId,
    workflowId,
  }).catch(() => null);
  return { written: true, notified };
}

async function notifyModelOwner({
  modelId,
  modelName,
  userId,
  label,
  workflowId,
}: {
  modelId: number;
  modelName: string;
  userId: number;
  label: TextScanFlagLabel;
  workflowId: string;
}) {
  if (userId <= 0) return false;
  await createNotification({
    userId,
    type: 'model-text-scan-flagged',
    category: NotificationCategory.Moderation,
    key: `model-text-scan-flagged:${modelId}:${label}:${workflowId}`,
    details: { modelId, modelName, label },
  });
  return true;
}

export async function grantModelTextScanPoi({
  modelId,
  userId,
  grantHash,
  via = 'appeal',
  reason,
  note,
  expectTextHash,
}: {
  modelId: number;
  userId: number;
  grantHash: string;
  via?: 'appeal' | 'moderator';
  reason?: string;
  note?: string;
  /** Lift only while the flag still carries this text hash; a flag since re-scanned is left alone. */
  expectTextHash?: string;
}) {
  if (!grantHash) throw new Error('A granted appeal needs the grant hash it covers');
  const before = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      userId: true,
      poi: true,
      minor: true,
      nsfw: true,
      sfwOnly: true,
      gallerySettings: true,
      lockedProperties: true,
    },
  });
  if (!before?.poi) return false;

  const [granted] = await writeTextScanRuling(
    { modelId, labels: ['poi'], decision: 'appealGranted', via, moderatorId: userId, reason, note },
    (tx) => tx.$queryRaw<ModelFlagRow[]>`
    UPDATE "Model" m
    SET poi = FALSE,
        nsfw = CASE WHEN m.minor THEN m.nsfw
          ELSE COALESCE((m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'prev'->>'nsfw')::boolean, m.nsfw) END,
        "sfwOnly" = CASE WHEN m.minor THEN m."sfwOnly"
          ELSE COALESCE((m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'prev'->>'sfwOnly')::boolean, m."sfwOnly") END,
        "gallerySettings" = CASE
          WHEN m.minor THEN m."gallerySettings"
          WHEN m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'prev'->>'galleryLevel' IS NULL
            THEN COALESCE(m."gallerySettings", '{}'::jsonb) - 'level'
          ELSE COALESCE(m."gallerySettings", '{}'::jsonb)
            || jsonb_build_object('level', (m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'prev'->>'galleryLevel')::int)
        END,
        "lockedProperties" = ARRAY(
          SELECT DISTINCT p
          FROM unnest(COALESCE(m."lockedProperties", ARRAY[]::text[]) || ARRAY['poi']::text[]) AS p
          WHERE p = 'poi'
             OR m.minor
             OR p NOT IN ('nsfw', 'sfwOnly')
             OR p IN (SELECT jsonb_array_elements_text(m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'prev'->'lockedProperties'))
        ),
        meta = jsonb_set(
          m.meta,
          ARRAY[${TEXT_SCAN_FLAGS_KEY}::text, 'poi'],
          (${flagEntryPath('poi')} - 'redetected')
            || ${carriedRulings('poi', ['appealGranted'])}
            || jsonb_build_object('appealGranted', jsonb_build_object(
              'at', now(),
              'by', ${userId}::int,
              'textHash', ${grantHash}::text,
              'via', ${via}::text
            ) || jsonb_strip_nulls(jsonb_build_object(
              'reason', ${reason ?? null}::text, 'note', ${note ?? null}::text
            )))
        )
    WHERE m.id = ${modelId}
      AND m.poi
      AND m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' IS NOT NULL
      ${
        expectTextHash
          ? Prisma.sql`AND ${flagEntryPath('poi')}->>'textHash' = ${expectTextHash}`
          : Prisma.empty
      }
    RETURNING m.id, m.name, m.description, m."userId", m.poi, m.nsfw, m.minor, m."sfwOnly",
              m.status, m."gallerySettings", m."lockedProperties"
  `,
    (rows) => rows.length > 0
  );
  if (!granted) return false;

  const { applyModelFlagSideEffects, clearPoiHashMeta, restoreOwnerFlagOverride } =
    await loadModelService();
  const after = {
    ...granted,
    ...(await restoreOwnerFlagOverride(modelId, { revertedFlag: 'poi' })),
  };
  await clearPoiHashMeta(modelId);
  await applyModelFlagSideEffects({ before, after });
  await updateModelNsfwLevels([modelId]);
  await bustPublicModelResponseCache(modelId);

  await new Tracker()
    .entityChanges(
      diffEntityChanges({
        entityType: 'Model',
        entityId: modelId,
        ownerId: before.userId,
        before: {
          poi: before.poi,
          nsfw: before.nsfw,
          sfwOnly: before.sfwOnly,
          lockedProperties: before.lockedProperties,
        },
        after: {
          poi: after.poi,
          nsfw: after.nsfw,
          sfwOnly: after.sfwOnly,
          lockedProperties: after.lockedProperties,
        },
        actorRole: 'moderator',
        reason: 'textScanAppealGranted',
      })
    )
    .catch(() => null);

  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'poi appeal granted',
    entityType: 'Model',
    entityId: modelId,
    moderatorId: userId,
  }).catch(() => null);
  return true;
}

export async function stampModelTextScanAppeal({
  modelId,
  userId,
  decision,
  labels,
  grantHashes,
  via = 'appeal',
  reason,
  note,
  expectTextHash,
  heldDetection,
}: {
  modelId: number;
  userId: number;
  decision: 'appealGranted' | 'appealUpheld';
  labels: TextScanFlagLabel[];
  grantHashes?: Partial<Record<TextScanFlagLabel, string>>;
  via?: 'appeal' | 'moderator';
  reason?: string;
  note?: string;
  /** Stamp only while the first label's flag still carries this text hash. */
  expectTextHash?: string;
  /** A held detection being ruled on: the verdict its label records, as the flag entry may not carry it whole. */
  heldDetection?: TextScanModelRuling['heldDetection'];
}): Promise<number> {
  if (!labels.length) return 0;
  // A grant covers the text the moderator reviewed, per label because the scan that owns a label
  // can differ. Falling back to the flagged hash would leave an owner's later edit uncovered, and
  // the next scan of it would re-flag and erase the grant. An upheld ruling keeps the flagged one.
  const granted = decision === 'appealGranted';
  if (granted && !labels.every((label) => grantHashes?.[label]))
    throw new Error('A granted appeal needs the grant hash it covers for every label');
  const hashes = JSON.stringify(granted ? grantHashes : {});
  return writeTextScanRuling(
    { modelId, labels, decision, via, moderatorId: userId, reason, note, heldDetection },
    (tx) => tx.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || (
        SELECT jsonb_object_agg(
          l.label,
          (COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}->l.label, '{}'::jsonb) - 'redetected')
          || ${carriedRulings(Prisma.sql`l.label`, [decision])} || jsonb_build_object(
            ${decision}::text, jsonb_build_object(
              'at', now(),
              'by', ${userId}::int,
              'textHash', COALESCE((${hashes}::jsonb)->>l.label, m.meta->${TEXT_SCAN_FLAGS_KEY}->l.label->>'textHash'),
              'via', ${via}::text
            ) || jsonb_strip_nulls(jsonb_build_object(
              'reason', ${reason ?? null}::text, 'note', ${note ?? null}::text
            ))
          )
        )
        FROM unnest(${labels}::text[]) AS l(label)
      )
    )
    WHERE m.id = ${modelId}
      ${
        expectTextHash
          ? Prisma.sql`AND ${flagEntryPath(labels[0])}->>'textHash' = ${expectTextHash}`
          : Prisma.empty
      }
  `,
    (changed) => changed > 0
  );
}

export async function reassertModelPoiRestrictions(modelId: number) {
  const before = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { poi: true, minor: true, nsfw: true, sfwOnly: true, gallerySettings: true },
  });
  if (!before?.poi) return false;

  const [after] = await dbWrite.$queryRaw<ModelFlagRow[]>`
    UPDATE "Model" m
    SET nsfw = FALSE,
        "sfwOnly" = TRUE,
        "gallerySettings" = COALESCE(m."gallerySettings", '{}'::jsonb)
          || jsonb_build_object('level', ${sfwBrowsingLevelsFlag}::int),
        "lockedProperties" = ARRAY(
          SELECT DISTINCT unnest(COALESCE(m."lockedProperties", ARRAY[]::text[]) || ${POI_LOCKED_PROPERTIES}::text[])
        )
    WHERE m.id = ${modelId}
      AND m.poi
      AND (
        m.nsfw
        OR NOT m."sfwOnly"
        OR (m."gallerySettings"->>'level')::int IS DISTINCT FROM ${sfwBrowsingLevelsFlag}::int
        OR NOT (COALESCE(m."lockedProperties", ARRAY[]::text[]) @> ${POI_LOCKED_PROPERTIES}::text[])
      )
    RETURNING m.id, m.name, m.description, m."userId", m.poi, m.nsfw, m.minor, m."sfwOnly",
              m.status, m."gallerySettings", m."lockedProperties"
  `;
  if (!after) return false;

  const { applyModelFlagSideEffects } = await loadModelService();
  await applyModelFlagSideEffects({ before, after });
  if (before.nsfw) await updateModelNsfwLevels([modelId]);
  await bustPublicModelResponseCache(modelId);
  return true;
}
