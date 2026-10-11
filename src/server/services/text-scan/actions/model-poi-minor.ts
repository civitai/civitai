import type { Prisma } from '@prisma/client';
import { Tracker } from '~/server/clickhouse/tracker';
import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { createNotification } from '~/server/services/notification.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import {
  appealGrantCoversText,
  buildTextScanFlagEntry,
  readTextScanFlags,
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { ModelStatus } from '~/shared/utils/prisma/enums';

export const POI_LOCKED_PROPERTIES = ['poi', 'nsfw', 'sfwOnly'];

export type PoiMinorResult = { notified: boolean };

const SYSTEM_USER_ID = constants.system.user.id;

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

function blockedByGrantOrLock(
  label: TextScanFlagLabel,
  model: { meta: Prisma.JsonValue; lockedProperties: string[] },
  textHash: string
) {
  if (!readTextScanFlags(model.meta)[label]?.appealGranted)
    return model.lockedProperties.includes(label);
  return appealGrantCoversText(model.meta, label, textHash);
}

export async function applyModelPoiMinor({
  entityId,
  workflowId,
  outcome,
  textHash,
}: ApplyTextScanArgs): Promise<PoiMinorResult> {
  let notified = false;
  if (outcome.poi?.newlyDetected)
    notified =
      (await flagModelPoi({
        modelId: entityId,
        workflowId,
        reason: outcome.poi.reason,
        names: outcome.poi.names,
        textHash,
      })) || notified;
  if (outcome.minor?.newlyDetected)
    notified =
      (await flagModelMinor({
        modelId: entityId,
        workflowId,
        reason: outcome.minor.reason,
        textHash,
      })) || notified;
  return { notified };
}

async function flagModelPoi({
  modelId,
  workflowId,
  reason,
  names,
  textHash,
}: {
  modelId: number;
  workflowId: string;
  reason: string;
  names: string[];
  textHash: string;
}): Promise<boolean> {
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
  if (!before || before.poi) return false;
  if (blockedByGrantOrLock('poi', before, textHash)) return false;

  const entry = JSON.stringify(buildTextScanFlagEntry({ workflowId, reason, names, textHash }));
  const [after] = await dbWrite.$queryRaw<ModelFlagRow[]>`
    UPDATE "Model" m
    SET poi = TRUE,
        nsfw = FALSE,
        "sfwOnly" = TRUE,
        "gallerySettings" = COALESCE(m."gallerySettings", '{}'::jsonb)
          || jsonb_build_object('level', ${sfwBrowsingLevelsFlag}::int),
        "lockedProperties" = ARRAY(
          SELECT DISTINCT unnest(COALESCE(m."lockedProperties", ARRAY[]::text[]) || ${POI_LOCKED_PROPERTIES}::text[])
        ),
        meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
          ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
            'poi', ${entry}::jsonb || jsonb_build_object(
              'at', now(),
              'promptIds', (SELECT em.result->'promptIds' FROM "EntityModeration" em
                            WHERE em."entityType" = 'Model' AND em."entityId" = m.id),
              'model', (SELECT em.result->'model' FROM "EntityModeration" em
                        WHERE em."entityType" = 'Model' AND em."entityId" = m.id),
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
      AND (
        (m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'appealGranted' IS NULL
          AND NOT ('poi' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[]))))
        OR (m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'appealGranted' IS NOT NULL
          AND m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'appealGranted'->>'textHash' IS DISTINCT FROM ${textHash})
      )
    RETURNING m.id, m.name, m.description, m."userId", m.poi, m.nsfw, m.minor, m."sfwOnly",
              m.status, m."gallerySettings", m."lockedProperties"
  `;
  if (!after) return false;

  const { applyModelFlagSideEffects } = await loadModelService();
  await applyModelFlagSideEffects({ before, after });
  if (before.nsfw) await updateModelNsfwLevels([modelId]);
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
        actorRole: 'system',
        systemFields: {
          poi: 'text-scan',
          nsfw: 'text-scan',
          sfwOnly: 'text-scan',
          lockedProperties: 'text-scan',
        },
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
  return notified;
}

async function flagModelMinor({
  modelId,
  workflowId,
  reason,
  textHash,
}: {
  modelId: number;
  workflowId: string;
  reason: string;
  textHash: string;
}): Promise<boolean> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { userId: true, name: true, minor: true, lockedProperties: true, meta: true },
  });
  if (!model || model.minor) return false;
  if (blockedByGrantOrLock('minor', model, textHash)) return false;

  const entry = JSON.stringify(buildTextScanFlagEntry({ workflowId, reason, textHash }));
  const written = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        'minor', ${entry}::jsonb || jsonb_build_object(
          'at', now(),
          'promptIds', (SELECT em.result->'promptIds' FROM "EntityModeration" em
                        WHERE em."entityType" = 'Model' AND em."entityId" = m.id),
          'model', (SELECT em.result->'model' FROM "EntityModeration" em
                    WHERE em."entityType" = 'Model' AND em."entityId" = m.id)
        )
      )
    )
    WHERE m.id = ${modelId}
      AND NOT m.minor
      AND (
        (m.meta->${TEXT_SCAN_FLAGS_KEY}->'minor'->'appealGranted' IS NULL
          AND NOT ('minor' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[]))))
        OR (m.meta->${TEXT_SCAN_FLAGS_KEY}->'minor'->'appealGranted' IS NOT NULL
          AND m.meta->${TEXT_SCAN_FLAGS_KEY}->'minor'->'appealGranted'->>'textHash' IS DISTINCT FROM ${textHash})
      )
  `;
  if (!written) return false;

  const { setModelMinor } = await loadModelService();
  await setModelMinor({
    id: modelId,
    minor: true,
    userId: SYSTEM_USER_ID,
    activity: 'setMinorTextScan',
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
  return notified;
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
    category: NotificationCategory.System,
    key: `model-text-scan-flagged:${modelId}:${label}:${workflowId}`,
    details: { modelId, modelName, label },
  });
  return true;
}

export async function grantModelTextScanPoi({
  modelId,
  userId,
  currentHash,
}: {
  modelId: number;
  userId: number;
  currentHash: string | null;
}) {
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

  const [after] = await dbWrite.$queryRaw<ModelFlagRow[]>`
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
          ARRAY[${TEXT_SCAN_FLAGS_KEY}::text, 'poi', 'appealGranted'],
          jsonb_build_object(
            'at', now(),
            'by', ${userId}::int,
            'textHash', COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->>'textHash', ${currentHash}::text),
            'via', 'appeal'
          )
        )
    WHERE m.id = ${modelId}
      AND m.poi
      AND m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' IS NOT NULL
    RETURNING m.id, m.name, m.description, m."userId", m.poi, m.nsfw, m.minor, m."sfwOnly",
              m.status, m."gallerySettings", m."lockedProperties"
  `;
  if (!after) return false;

  const { applyModelFlagSideEffects } = await loadModelService();
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
  currentHash = null,
}: {
  modelId: number;
  userId: number;
  decision: 'appealGranted' | 'appealUpheld';
  labels: TextScanFlagLabel[];
  currentHash?: string | null;
}) {
  if (!labels.length) return;
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || (
        SELECT jsonb_object_agg(
          l.label,
          COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}->l.label, '{}'::jsonb) || jsonb_build_object(
            ${decision}::text, jsonb_build_object(
              'at', now(),
              'by', ${userId}::int,
              'textHash', COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}->l.label->>'textHash', ${currentHash}::text),
              'via', 'appeal'
            )
          )
        )
        FROM unnest(${labels}::text[]) AS l(label)
      )
    )
    WHERE m.id = ${modelId}
  `;
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
