import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `licensingSourceVersionId` makes a version inherit a root's per-image licence fee: the fee is
 * charged to everyone who GENERATES with the derivative and settled to the ROOT's owner, on a line
 * labelled with the derivative's name. So the field decides who is paid, by whom, per image — and it
 * arrives over the wire from a form, which is why it is validated here rather than trusted.
 *
 * Every `LicensingRoot` row is `modelType: 'Checkpoint'`. The guard used to check the base model and
 * not the model type, so a LoRA could hold a checkpoint's fee: CU 868kwf2fd / Freshdesk #69622, where
 * the reporter paid 10 Buzz/image instead of 5 for a month and no surface on the site could clear it.
 */

const { mockUpsertModelVersion, mockGetModel } = vi.hoisted(() => ({
  mockUpsertModelVersion: vi.fn(),
  mockGetModel: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  upsertModelVersion: mockUpsertModelVersion,
  assertUserEarlyAccessLimits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

import { upsertModelVersionHandler } from '~/server/controllers/model-version.controller';

const MODEL_ID = 2790719;
const OWNER_ID = 5479411;
/** Anima base-v1.0 — a Checkpoint root charging 5.00 PerImageBuzz. */
const ANIMA_ROOT_VERSION_ID = 2945208;

/** The stored `LicensingRoot` row for {@link ANIMA_ROOT_VERSION_ID}. */
const animaRoot = { baseModel: 'Anima', modelType: 'Checkpoint' };

const call = async ({
  modelType,
  baseModel = 'Anima',
  root = animaRoot as { baseModel: string; modelType: string } | null,
  licensingSourceVersionId = ANIMA_ROOT_VERSION_ID as number | null,
}: {
  /** `null` stands for a modelId that resolves to no model — the handler cannot check the type then. */
  modelType: string | null;
  baseModel?: string;
  root?: { baseModel: string; modelType: string } | null;
  licensingSourceVersionId?: number | null;
}) => {
  mockGetModel.mockResolvedValue(modelType === null ? null : { type: modelType, nsfw: false });
  dbMock.dbRead.licensingRoot.findUnique.mockResolvedValue(root);

  await upsertModelVersionHandler({
    input: {
      modelId: MODEL_ID,
      name: 'v1.0',
      baseModel,
      // Download keeps the generation-only entitlement gate out of the way, and a null fee keeps the
      // tier-cap branch out. Neither is what this file is about.
      usageControl: 'Download',
      licensingFee: null,
      licensingSourceVersionId,
    },
    ctx: {
      user: { id: OWNER_ID, isModerator: false, meta: {} },
      features: {},
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

  return mockUpsertModelVersion.mock.calls[0][0] as {
    licensingSourceVersionId: number | null;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertModelVersion.mockResolvedValue({ id: 3144879, modelId: MODEL_ID });
});

describe('upsertModelVersionHandler — licensing lineage scope', () => {
  it('drops a checkpoint root from a LORA', async () => {
    const written = await call({ modelType: 'LORA' });
    expect(written.licensingSourceVersionId).toBeNull();
  });

  // The control for the test above. Same root, same base model, same call shape — only the model type
  // differs, so a `licensingSourceVersionId: null` that came from the handler ignoring the field
  // entirely (or from the mock never being read) fails here instead of passing everywhere.
  it('keeps a checkpoint root on a CHECKPOINT', async () => {
    const written = await call({ modelType: 'Checkpoint' });
    expect(written.licensingSourceVersionId).toBe(ANIMA_ROOT_VERSION_ID);
  });

  it.each([
    ['the base model does not match', { baseModel: 'Illustrious' }],
    ['the source is not a registered root', { root: null }],
    // "Could not check" must land on the same side as "checked and wrong". Written as a permissive
    // `sourceModel && …` this case passes the source straight through, and the guard reads as enforced
    // while being inert for it.
    ['the model itself cannot be read', { modelType: null }],
  ])('drops a source when %s', async (_label, overrides) => {
    const written = await call({ modelType: 'Checkpoint', ...overrides });
    expect(written.licensingSourceVersionId).toBeNull();
  });

  // 🔴 Coercion, not rejection, is the deliberate half of this fix — see the comment on the guard.
  // Throwing would make all 160 already-stamped versions unsaveable by their owners, because the
  // version editor resubmits the stored value out of `defaultValues`. If someone "tightens" the guard
  // into a throw, this is the test that says why not.
  it('saves rather than erroring when it drops one', async () => {
    await expect(call({ modelType: 'LORA' })).resolves.toBeDefined();
    expect(mockUpsertModelVersion).toHaveBeenCalledTimes(1);
  });

  it('leaves an unset source alone without reading the root table', async () => {
    const written = await call({ modelType: 'LORA', licensingSourceVersionId: null });
    expect(written.licensingSourceVersionId).toBeNull();
    expect(dbMock.dbRead.licensingRoot.findUnique).not.toHaveBeenCalled();
  });
});
