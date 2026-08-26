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

const OWNER_ID = 5479411;
/** The model named in the payload. */
const PAYLOAD_MODEL_ID = 2790719;
/** The model the version being edited actually belongs to — deliberately a different row. */
const STORED_MODEL_ID = 999001;
const VERSION_ID = 3144879;
/** Anima base-v1.0 — a Checkpoint root charging 5.00 PerImageBuzz. */
const ANIMA_ROOT_VERSION_ID = 2945208;

/** The stored `LicensingRoot` row for {@link ANIMA_ROOT_VERSION_ID}. */
const animaRoot = { baseModel: 'Anima', modelType: 'Checkpoint' };

type Root = { baseModel: string; modelType: string } | null;

/**
 * `modelTypes` maps a model id to the type stored for it, or to `null` for a row that cannot be read.
 * Keyed by id on purpose: the payload's model and the edited version's model are different rows, and
 * the whole point of the update test is that the guard must use the latter.
 */
const call = async ({
  modelTypes,
  id,
  baseModel = 'Anima',
  root = animaRoot as Root,
  licensingSourceVersionId = ANIMA_ROOT_VERSION_ID as number | null,
}: {
  modelTypes: Record<number, string | null>;
  id?: number;
  baseModel?: string;
  root?: Root;
  licensingSourceVersionId?: number | null;
}) => {
  dbMock.dbRead.licensingRoot.findUnique.mockResolvedValue(root);
  // Serves both reads the handler makes off this table: `storedUsageControl` and the owning modelId.
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
    usageControl: 'Download',
    modelId: STORED_MODEL_ID,
  });
  dbMock.dbWrite.model.findUnique.mockImplementation(async (args: { where: { id: number } }) => {
    const type = modelTypes[args.where.id];
    return type == null ? null : { type };
  });
  // Only reached after the write, for the nsfw read on the create branch.
  mockGetModel.mockResolvedValue({ nsfw: false, type: 'LORA' });

  await upsertModelVersionHandler({
    input: {
      id,
      modelId: PAYLOAD_MODEL_ID,
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
    licensingSourceCoerced?: boolean;
  };
};

/** A create, where the payload's model IS the version's model. */
const creating = (type: string | null) => ({ modelTypes: { [PAYLOAD_MODEL_ID]: type } });

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertModelVersion.mockResolvedValue({ id: VERSION_ID, modelId: PAYLOAD_MODEL_ID });
});

describe('upsertModelVersionHandler — licensing lineage scope', () => {
  it('drops a checkpoint root from a LORA', async () => {
    const written = await call(creating('LORA'));
    expect(written.licensingSourceVersionId).toBeNull();
  });

  // The control for the test above, and the reason it is worth anything: same root, same base model,
  // same call shape — only the model type differs. A `licensingSourceVersionId: null` that came from
  // the handler ignoring the field entirely, or from the mocks never being read, fails here instead of
  // passing everywhere.
  it('keeps a checkpoint root on a CHECKPOINT', async () => {
    const written = await call(creating('Checkpoint'));
    expect(written.licensingSourceVersionId).toBe(ANIMA_ROOT_VERSION_ID);
  });

  it.each([
    ['the base model does not match', { baseModel: 'Illustrious' }],
    ['the source is not a registered root', { root: null }],
    // "Could not check" must land on the same side as "checked and wrong". Written the permissive way
    // this case passes the source straight through, and the guard reads as enforced while being inert
    // for it.
    ['the model itself cannot be read', { modelTypes: { [PAYLOAD_MODEL_ID]: null } }],
  ])('drops a source when %s', async (_label, overrides) => {
    const written = await call({ ...creating('Checkpoint'), ...overrides });
    expect(written.licensingSourceVersionId).toBeNull();
  });

  // 🔴 The type comes from the model the EDITED VERSION belongs to, never from the payload.
  // `isOwnerOrModerator` authorises against the version's stored modelId and never compares it to
  // `input.modelId`, so a caller who owns both a LoRA and a Checkpoint can name the Checkpoint in the
  // payload while editing the LoRA's version. Read the payload's model here and the type check is
  // satisfied by a model the row has nothing to do with.
  it('reads the type from the edited version, not from the payload', async () => {
    const written = await call({
      id: VERSION_ID,
      modelTypes: { [PAYLOAD_MODEL_ID]: 'Checkpoint', [STORED_MODEL_ID]: 'LORA' },
    });
    expect(written.licensingSourceVersionId).toBeNull();
    expect(dbMock.dbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: STORED_MODEL_ID } })
    );
  });

  // 🔴 Coercion, not rejection, is the deliberate half of this fix — see the comment on the guard.
  // Throwing would make every already-stamped version unsaveable by its owner, because the version
  // editor resubmits the stored value out of `defaultValues`. If someone "tightens" the guard into a
  // throw, this is the test that says why not.
  it('saves rather than erroring when it drops one', async () => {
    await expect(call(creating('LORA'))).resolves.toBeDefined();
    expect(mockUpsertModelVersion).toHaveBeenCalledTimes(1);
  });

  // A coercion is a rule acting, not the creator. Without this flag the audit rows this fix exists to
  // produce would name owners who did nothing — worse than the missing trail it replaces.
  it('tells the service the clear was automated, and only when it was', async () => {
    expect((await call(creating('LORA'))).licensingSourceCoerced).toBe(true);
    vi.clearAllMocks();
    mockUpsertModelVersion.mockResolvedValue({ id: VERSION_ID, modelId: PAYLOAD_MODEL_ID });
    expect((await call(creating('Checkpoint'))).licensingSourceCoerced).toBe(false);
  });

  it('leaves an unset source alone without reading the root table', async () => {
    const written = await call({ ...creating('LORA'), licensingSourceVersionId: null });
    expect(written.licensingSourceVersionId).toBeNull();
    expect(dbMock.dbRead.licensingRoot.findUnique).not.toHaveBeenCalled();
  });
});
