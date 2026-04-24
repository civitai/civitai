import { Prisma, type GenerationPreset } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  CreateGenerationPresetInput,
  GetPresetsForEcosystemInput,
  ReorderGenerationPresetsInput,
  UpdateGenerationPresetInput,
} from '~/server/schema/generation-preset.schema';
import {
  throwAuthorizationError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  areResourcesCompatible,
  ecosystemByKey,
  getRootEcosystem,
} from '~/shared/constants/basemodel.constants';
import { RESOURCE_NODE_KEYS } from '~/shared/utils/resource.utils';

const SYSTEM_USER_ID = constants.system.user.id;

type PresetValues = Record<string, unknown>;

/**
 * Flatten every resource slot (model/upscaler/resources/vae/…future) into a
 * list of ids. Iterates `RESOURCE_NODE_KEYS` so new slots added to the shared
 * constant in `resource.utils.ts` automatically flow through here.
 */
function extractResourceIds(values: PresetValues): number[] {
  const ids: number[] = [];
  for (const key of RESOURCE_NODE_KEYS) {
    const val = values[key];
    if (Array.isArray(val)) {
      for (const r of val as Array<{ id?: number }>) if (r?.id) ids.push(r.id);
    } else if (val && typeof (val as { id?: unknown }).id === 'number') {
      ids.push((val as { id: number }).id);
    }
  }
  return ids;
}

function hasResourceRefs(values: PresetValues) {
  return extractResourceIds(values).length > 0;
}

async function fetchResourceMeta(ids: number[]) {
  if (ids.length === 0) return new Map<number, { baseModel: string; modelType: string }>();
  const rows = await dbRead.modelVersion.findMany({
    where: { id: { in: ids } },
    select: { id: true, baseModel: true, model: { select: { type: true } } },
  });
  const map = new Map<number, { baseModel: string; modelType: string }>();
  for (const row of rows) {
    if (row.baseModel) map.set(row.id, { baseModel: row.baseModel, modelType: row.model.type });
  }
  return map;
}

/**
 * Return every preset visible to the user that can be applied in the current
 * ecosystem. "Visible" = the user's own + curated system presets (userId = -1).
 *
 * Direct matches: preset.ecosystem === ecosystem.
 * Cross-compatible: preset.ecosystem !== ecosystem but either
 *   (a) the preset has resource refs and all resources are compatible with the
 *       current ecosystem per `areResourcesCompatible`, or
 *   (b) the preset has no resource refs and the two ecosystems share a root.
 */
export async function getPresetsForEcosystem({
  userId,
  ecosystem,
}: GetPresetsForEcosystemInput & { userId: number }) {
  const ecosystemRecord = ecosystemByKey.get(ecosystem);
  if (!ecosystemRecord) return [];

  const presets = await dbRead.generationPreset.findMany({
    where: { userId: { in: [userId, SYSTEM_USER_ID] } },
    // userId = -1 sorts before any positive id, so system presets pin to top.
    orderBy: [{ userId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const direct = presets.filter((p) => p.ecosystem === ecosystem);
  const other = presets.filter((p) => p.ecosystem !== ecosystem);

  // Collect resource ids across cross-ecosystem candidates for a single bulk fetch.
  const resourceIds = new Set<number>();
  for (const preset of other) {
    for (const id of extractResourceIds(preset.values as PresetValues)) resourceIds.add(id);
  }
  const resourceMeta = await fetchResourceMeta([...resourceIds]);

  const currentRoot = getRootEcosystem(ecosystemRecord.id);
  const crossCompatible = other.filter((preset) => {
    const values = preset.values as PresetValues;
    if (hasResourceRefs(values)) {
      const refs = extractResourceIds(values)
        .map((id) => resourceMeta.get(id))
        .filter((m): m is { baseModel: string; modelType: string } => !!m)
        .map((m) => ({ baseModel: m.baseModel, model: { type: m.modelType } }));
      // If resource metadata couldn't be resolved (deleted models, etc.), skip.
      if (refs.length === 0) return false;
      return areResourcesCompatible(ecosystemRecord.id, refs);
    }
    // Settings-only preset: visible when ecosystems share a root.
    const presetEco = ecosystemByKey.get(preset.ecosystem);
    if (!presetEco) return false;
    try {
      return getRootEcosystem(presetEco.id).id === currentRoot.id;
    } catch {
      return false;
    }
  });

  return [...direct, ...crossCompatible];
}

/** User's own presets only — used by the manage modal and the glow check. */
export async function getUserPresets({ userId }: { userId: number }): Promise<GenerationPreset[]> {
  return dbRead.generationPreset.findMany({
    where: { userId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * User's own presets + curated system presets. Used by the picker so users
 * see both their personal saves and team-curated starting points.
 *
 * System presets sort first because `userId = -1` is less than any positive id.
 */
export async function getAvailablePresets({
  userId,
}: {
  userId: number;
}): Promise<GenerationPreset[]> {
  return dbRead.generationPreset.findMany({
    where: { userId: { in: [userId, SYSTEM_USER_ID] } },
    orderBy: [{ userId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function getPresetById({ id, userId }: { id: number; userId: number }) {
  const preset = await dbRead.generationPreset.findUnique({ where: { id } });
  if (!preset) throw throwNotFoundError('Preset not found');
  // Allow read if it's a curated system preset, or the caller owns it.
  if (preset.userId !== SYSTEM_USER_ID && preset.userId !== userId) {
    throw throwAuthorizationError();
  }
  return preset;
}

function isUniqueNameViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as string[]).includes('name')
  );
}

export async function createGenerationPreset({
  userId,
  input,
}: {
  userId: number;
  input: CreateGenerationPresetInput;
}) {
  const ecosystem = (input.values.ecosystem as string) ?? '';
  const values = input.values as Prisma.InputJsonValue;
  const max = await dbRead.generationPreset.aggregate({
    where: { userId },
    _max: { sortOrder: true },
  });
  const nextSortOrder = (max._max.sortOrder ?? -1) + 1;

  try {
    return await dbWrite.generationPreset.create({
      data: {
        userId,
        name: input.name,
        description: input.description ?? null,
        ecosystem,
        values,
        sortOrder: nextSortOrder,
      },
    });
  } catch (error) {
    if (isUniqueNameViolation(error)) {
      throw throwConflictError('A preset with this name already exists for this ecosystem.');
    }
    throw error;
  }
}

export async function updateGenerationPreset({
  userId,
  isModerator,
  input,
}: {
  userId: number;
  isModerator: boolean;
  input: UpdateGenerationPresetInput;
}) {
  const existing = await dbRead.generationPreset.findUnique({ where: { id: input.id } });
  if (!existing) throw throwNotFoundError('Preset not found');
  if (existing.userId === SYSTEM_USER_ID) {
    if (!isModerator) throw throwAuthorizationError();
  } else if (existing.userId !== userId) {
    throw throwAuthorizationError();
  }

  const data: Prisma.GenerationPresetUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.values !== undefined) {
    data.values = input.values as Prisma.InputJsonValue;
    data.ecosystem = input.values.ecosystem as string;
  }

  try {
    return await dbWrite.generationPreset.update({ where: { id: input.id }, data });
  } catch (error) {
    if (isUniqueNameViolation(error)) {
      throw throwConflictError('A preset with this name already exists for this ecosystem.');
    }
    throw error;
  }
}

export async function deleteGenerationPreset({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator: boolean;
  id: number;
}) {
  const existing = await dbRead.generationPreset.findUnique({ where: { id } });
  if (!existing) throw throwNotFoundError('Preset not found');
  if (existing.userId === SYSTEM_USER_ID) {
    if (!isModerator) throw throwAuthorizationError();
  } else if (existing.userId !== userId) {
    throw throwAuthorizationError();
  }

  await dbWrite.generationPreset.delete({ where: { id } });
  return { id };
}

export async function reorderGenerationPresets({
  userId,
  input,
}: {
  userId: number;
  input: ReorderGenerationPresetsInput;
}) {
  const owned = await dbRead.generationPreset.findMany({
    where: { id: { in: input.orderedIds }, userId },
    select: { id: true },
  });
  if (owned.length !== input.orderedIds.length) throw throwAuthorizationError();

  await dbWrite.$transaction(
    input.orderedIds.map((id, index) =>
      dbWrite.generationPreset.update({ where: { id }, data: { sortOrder: index } })
    )
  );
  return { ok: true };
}
