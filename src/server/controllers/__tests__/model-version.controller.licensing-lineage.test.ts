import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';

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

const { mockUpsertModelVersion, mockGetModel, mockReadFliptBoolean } = vi.hoisted(() => ({
  mockUpsertModelVersion: vi.fn(),
  mockGetModel: vi.fn(),
  mockReadFliptBoolean: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  readFliptBoolean: mockReadFliptBoolean,
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
import { baseModelLicenses } from '~/server/common/constants';
import { isHiddenBaseModel } from '~/shared/constants/basemodel.constants';

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
  templateId,
  baseModel = 'Anima',
  root = animaRoot as Root,
  licensingSourceVersionId = ANIMA_ROOT_VERSION_ID as number | null,
  omitSource = false,
  storedLicensingSourceVersionId = null as number | null,
  storedFee = {} as Record<string, unknown>,
  extraInput = {} as Record<string, unknown>,
  isModerator = false,
}: {
  modelTypes: Record<number, string | null>;
  id?: number;
  templateId?: number;
  baseModel?: string;
  root?: Root;
  licensingSourceVersionId?: number | null;
  /**
   * Leave the key off the payload entirely. Not `licensingSourceVersionId: undefined` — a
   * destructuring default fires on `undefined`, so that spelling would quietly send the default
   * source instead of omitting it, and every test below would be testing the ordinary path.
   */
  omitSource?: boolean;
  /** What the row being edited already holds — what a payload that omits the field falls back to. */
  storedLicensingSourceVersionId?: number | null;
  /** Fee columns on the row being edited. */
  storedFee?: Record<string, unknown>;
  extraInput?: Record<string, unknown>;
  isModerator?: boolean;
}) => {
  dbMock.dbWrite.licensingRoot.findUnique.mockResolvedValue(root);
  // Keyed on the argument, NOT a flat `mockResolvedValue`. A mock that ignores its `where` hands
  // STORED_MODEL_ID back whatever row the guard asked for, which leaves the one test in this file about
  // *which row was looked up* unable to detect the wrong row being looked up. Measured: with a flat
  // mock, changing the guard to read `input.modelId` left all nine tests green.
  dbMock.dbWrite.modelVersion.findUnique.mockImplementation(
    async (args: { where: { id: number } }) =>
      args.where.id === VERSION_ID
        ? {
            usageControl: 'Download',
            modelId: STORED_MODEL_ID,
            licensingSourceVersionId: storedLicensingSourceVersionId,
            ...storedFee,
          }
        : null
  );
  dbMock.dbWrite.model.findUnique.mockImplementation(async (args: { where: { id: number } }) => {
    const type = modelTypes[args.where.id];
    return type == null ? null : { type };
  });
  // Only reached after the write, for the nsfw read on the create branch.
  mockGetModel.mockResolvedValue({ nsfw: false, type: 'LORA' });

  await upsertModelVersionHandler({
    input: {
      id,
      templateId,
      modelId: PAYLOAD_MODEL_ID,
      name: 'v1.0',
      baseModel,
      // Download keeps the generation-only entitlement gate out of the way, and a null fee keeps the
      // tier-cap branch out. Neither is what this file is about.
      usageControl: 'Download',
      licensingFee: null,
      ...(omitSource ? {} : { licensingSourceVersionId }),
      ...extraInput,
    },
    ctx: {
      user: { id: OWNER_ID, isModerator, meta: {} },
      features: {},
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

  return mockUpsertModelVersion.mock.calls[0][0] as {
    licensingSourceVersionId: number | null;
    licensingSourceCoercedReason?: string;
  };
};

/** A create, where the payload's model IS the version's model. */
const creating = (type: string | null) => ({ modelTypes: { [PAYLOAD_MODEL_ID]: type } });

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertModelVersion.mockResolvedValue({ id: VERSION_ID, modelId: PAYLOAD_MODEL_ID });
  mockReadFliptBoolean.mockReset();
  mockReadFliptBoolean.mockResolvedValue(true);
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

  // 🔴 The rule is "the destination's type equals the ROOT's type", not "the destination is a
  // Checkpoint". Every LicensingRoot row is a Checkpoint today, so with only Checkpoint fixtures a
  // guard hardcoded to `!== 'Checkpoint'` passes every other test in this file — measured. The day a
  // LoRA or Video root is registered, that guard would drop every legitimate same-type lineage while
  // the suite still reported the rule as enforced.
  const loraRoot = { baseModel: 'Anima', modelType: 'LORA' };

  it('keeps a LORA root on a LORA, though no such root exists yet', async () => {
    const written = await call({ ...creating('LORA'), root: loraRoot });
    expect(written.licensingSourceVersionId).toBe(ANIMA_ROOT_VERSION_ID);
  });

  it('drops a LORA root from a CHECKPOINT', async () => {
    const written = await call({ ...creating('Checkpoint'), root: loraRoot });
    expect(written.licensingSourceVersionId).toBeNull();
    expect(written.licensingSourceCoercedReason).toBe('model-type-mismatch');
  });

  // 🔴 The type is checked against `input.modelId` — the model this save LANDS the version on —
  // and NOT against the model it currently belongs to. `modelId` rides `...data` into
  // `dbWrite.modelVersion.update`, so the payload's modelId is not a claim to be verified, it is the
  // instruction for where the version will live, and that is where the fee will apply.
  //
  // Both tests below describe a MOVE, and they pull in opposite directions on purpose. Check the
  // stored model instead and the first passes wrongly; require both to match and the second fails
  // wrongly. Two earlier rounds of this fix shipped one mistake each.
  it('rejects a root the DESTINATION model cannot hold, whatever the version came from', async () => {
    const written = await call({
      id: VERSION_ID,
      modelTypes: { [PAYLOAD_MODEL_ID]: 'LORA', [STORED_MODEL_ID]: 'Checkpoint' },
    });
    expect(written.licensingSourceVersionId).toBeNull();
    expect(dbMock.dbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAYLOAD_MODEL_ID } })
    );
  });

  // The legitimate move: a checkpoint filed under a model someone mis-typed as LORA, moved to a
  // properly typed Checkpoint model with its root intact. The fee is valid at the destination, so it
  // must survive. Nothing tells the creator when it does not — `mini/[id]` reads a null source as NO
  // lineage fee, not as a fallback — so an over-strict guard here quietly stops a payment.
  it('keeps the root when a move lands the version somewhere it fits', async () => {
    const written = await call({
      id: VERSION_ID,
      modelTypes: { [PAYLOAD_MODEL_ID]: 'Checkpoint', [STORED_MODEL_ID]: 'LORA' },
    });
    expect(written.licensingSourceVersionId).toBe(ANIMA_ROOT_VERSION_ID);
  });

  // "Could not check the destination" has to land with "checked and wrong". Written permissively this
  // case passes the source straight through on the exact path the guard exists for.
  it('drops the source when the destination model cannot be read', async () => {
    const written = await call({ id: VERSION_ID, modelTypes: { [STORED_MODEL_ID]: 'Checkpoint' } });
    expect(written.licensingSourceVersionId).toBeNull();
    expect(written.licensingSourceCoercedReason).toBe('model-not-found');
  });

  // 🔴 Coercion, not rejection, is the deliberate half of this fix — see the comment on the guard.
  // Throwing would make every already-stamped version unsaveable by its owner, because the version
  // editor resubmits the stored value out of `defaultValues`. If someone "tightens" the guard into a
  // throw, this is the test that says why not.
  it('saves rather than erroring when it drops one', async () => {
    await expect(call(creating('LORA'))).resolves.toBeDefined();
    expect(mockUpsertModelVersion).toHaveBeenCalledTimes(1);
  });

  // A coercion is a rule acting, not the creator, and the audit has to say WHICH rule. A bare boolean
  // collapses four distinct branches into one sentence, so a moderator reading the change history
  // cannot tell a type mismatch from a model that could not be read. With no flag at all, the rows this
  // fix exists to produce name owners who did nothing — worse than the missing trail it replaces.
  it.each([
    ['a type mismatch', {}, 'model-type-mismatch'],
    ['an unregistered source', { root: null }, 'not-a-root'],
    ['a base-model mismatch', { baseModel: 'Illustrious' }, 'base-model-mismatch'],
  ])('tells the service the clear was automated, and why: %s', async (_l, overrides, expected) => {
    const written = await call({ ...creating('LORA'), ...overrides });
    expect(written.licensingSourceCoercedReason).toBe(expected);
  });

  it('says nothing about coercion when it kept the source', async () => {
    expect((await call(creating('Checkpoint'))).licensingSourceCoercedReason).toBeUndefined();
  });

  // Only the call-count assertion is worth anything here: with the input already null, nothing in any
  // implementation of the guard assigns to it, so asserting it came back null passes even with the
  // whole block deleted. Dropped rather than left in as apparent coverage.
  it('leaves an unset source alone without reading the root table', async () => {
    await call({ ...creating('LORA'), licensingSourceVersionId: null });
    expect(dbMock.dbWrite.licensingRoot.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 A save does not have to NAME the stamp to invalidate it. `licensingSourceVersionId` is nullish
 * in the schema while `baseModel` and `modelId` are required, and a field absent from the payload
 * leaves the column untouched — so the guard, gated on the submitted value, never ran on the save
 * that broke the row. `TrainingSubmit` sends exactly that shape: it updates the first version with a
 * newly chosen `baseModel` and no stamp field, so a creator who stamped that version and then re-ran
 * training on a different base kept a third party's per-image fee.
 *
 * Measured on prod 2026-09-02 before the fix: 0 rows in that state (2,124 stamped versions, 0 with a
 * base model disagreeing with their root), and 0 base-model coercions in `entityChangeEvents` ever.
 * Reachable and unguarded, not an incident — sized accordingly.
 */
describe('upsertModelVersionHandler — a save that omits the stamp', () => {
  const omitting = (overrides: Partial<Parameters<typeof call>[0]> = {}) => ({
    id: VERSION_ID,
    modelTypes: { [PAYLOAD_MODEL_ID]: 'Checkpoint', [STORED_MODEL_ID]: 'Checkpoint' },
    omitSource: true,
    storedLicensingSourceVersionId: ANIMA_ROOT_VERSION_ID,
    ...overrides,
  });

  it('coerces a stored source the save has moved the base model away from', async () => {
    const written = await call(omitting({ baseModel: 'Illustrious' }));
    expect(written.licensingSourceVersionId).toBeNull();
    expect(written.licensingSourceCoercedReason).toBe('base-model-mismatch');
  });

  // The control, and the only thing that makes the test above worth anything: same call, same omitted
  // field, base model still matching the root. A fix that cleared the stamp on every stamp-omitting
  // save — which is what "coerce whenever the client didn't send it" would do — fails here.
  it('keeps a stored source the save leaves matching', async () => {
    const written = await call(omitting());
    expect(written.licensingSourceVersionId).toBe(ANIMA_ROOT_VERSION_ID);
    expect(written.licensingSourceCoercedReason).toBeUndefined();
  });

  // Judging the stored value means the model-type half of the same guard now fires on these saves
  // too. That is a deliberate widening beyond the base-model path — the same repair the guard already
  // performs on a full save, now reached by a partial one. It is pinned here so that removing it is a
  // decision rather than an accident.
  it('coerces a stored source whose model type no longer matches, not only its base model', async () => {
    const written = await call(omitting({ modelTypes: { [PAYLOAD_MODEL_ID]: 'LORA' } }));
    expect(written.licensingSourceVersionId).toBeNull();
    expect(written.licensingSourceCoercedReason).toBe('model-type-mismatch');
  });

  // The seed opens the whole rejection ladder to partial saves, not only its base-model rung, so the
  // other rungs are pinned here too rather than left to be discovered by whoever changes one.
  it('coerces a stored source that is no longer a registered root', async () => {
    const written = await call(omitting({ root: null }));
    expect(written.licensingSourceVersionId).toBeNull();
    expect(written.licensingSourceCoercedReason).toBe('not-a-root');
  });

  it('coerces a stored source when the destination model cannot be read', async () => {
    const written = await call(omitting({ modelTypes: { [STORED_MODEL_ID]: 'Checkpoint' } }));
    expect(written.licensingSourceVersionId).toBeNull();
    expect(written.licensingSourceCoercedReason).toBe('model-not-found');
  });

  // `undefined` is "the client said nothing"; `null` is the owner clearing the stamp. Seeding on
  // anything looser than `=== undefined` restores a source the creator just removed.
  it('does not restore a stored source over an explicit null', async () => {
    const written = await call(omitting({ omitSource: false, licensingSourceVersionId: null }));
    expect(written.licensingSourceVersionId).toBeNull();
    expect(dbMock.dbWrite.licensingRoot.findUnique).not.toHaveBeenCalled();
  });

  it('reads no root table when the stored row carries no source either', async () => {
    await call(omitting({ storedLicensingSourceVersionId: null }));
    expect(dbMock.dbWrite.licensingRoot.findUnique).not.toHaveBeenCalled();
  });
});

describe('upsertModelVersionHandler — trainingStatus on create', () => {
  it.each(['Denied', 'Paused'])(
    'refuses a non-moderator creating a version as %s',
    async (trainingStatus) => {
      await expect(
        call({ ...creating('LORA'), extraInput: { trainingStatus } })
      ).rejects.toThrowError(/training status/i);

      expect(mockUpsertModelVersion).not.toHaveBeenCalled();
    }
  );

  it.each([['Pending'], ['Approved'], ['Submitted'], [undefined], [null]])(
    'lets a non-moderator create with %s',
    async (trainingStatus) => {
      await call({ ...creating('LORA'), extraInput: { trainingStatus } });

      expect(mockUpsertModelVersion).toHaveBeenCalled();
    }
  );

  it('lets a moderator create as Denied', async () => {
    await call({
      ...creating('LORA'),
      extraInput: { trainingStatus: 'Denied' },
      isModerator: true,
    });

    expect(mockUpsertModelVersion).toHaveBeenCalled();
  });

  it('leaves an update to the service, which judges it against the stored value', async () => {
    await call({
      id: VERSION_ID,
      modelTypes: { [PAYLOAD_MODEL_ID]: 'LORA' },
      extraInput: { trainingStatus: 'Approved' },
    });

    expect(mockUpsertModelVersion).toHaveBeenCalled();
  });
});

describe('upsertModelVersionHandler — percent-of-compute fee, type-only write', () => {
  // The fee block in the handler runs only when the payload carries a fee; a payload with only the type
  // must still reach the percent rule, or a creator turns a per-image fee into a percent of compute.
  const typeOnly = (isModerator: boolean) =>
    call({
      ...creating('Checkpoint'),
      id: VERSION_ID,
      licensingSourceVersionId: null,
      isModerator,
      storedFee: { licensingFee: 5, licensingFeeType: 'PerImageBuzz' },
      extraInput: { licensingFee: undefined, licensingFeeType: 'PercentOfCompute' },
    });

  it('refuses a creator', async () => {
    await expect(typeOnly(false)).rejects.toThrow(/Percentage license fees are restricted/);
  });

  it('lets a moderator (control)', async () => {
    expect(await typeOnly(true)).toMatchObject({ licensingFeeType: 'PercentOfCompute' });
    expect(mockReadFliptBoolean).toHaveBeenCalledWith('licensing-fee-percent-of-compute');
  });

  // Until the orchestrator charges by the type, a percent is charged as that many Buzz per image, so
  // not even staff may set one before the flag is turned on. Do not drop this gate while the
  // orchestrator still reads the fee as Buzz per image.
  it.each([
    ['off', false],
    ['unreadable', null],
  ])('refuses a moderator while the percent flag is %s', async (_label, flag) => {
    mockReadFliptBoolean.mockResolvedValue(flag);
    await expect(typeOnly(true)).rejects.toThrow(/Percentage license fees are not available yet/);
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
  });

  // The handler defaults an omitted type. Defaulting to PerImageBuzz would turn a staff-set 35% into
  // 35 Buzz per image, a fee only staff could have created, now in the owner's hands.
  it('a null type with no fee keeps a staff-set percent (never writes the null)', async () => {
    const written = (await call({
      ...creating('Checkpoint'),
      id: VERSION_ID,
      licensingSourceVersionId: null,
      storedFee: { licensingFee: 35, licensingFeeType: 'PercentOfCompute' },
      extraInput: { licensingFee: undefined, licensingFeeType: null },
    })) as { licensingFeeType?: string | null };
    expect(written.licensingFeeType).toBeUndefined();
  });

  it('a fee-only save keeps a staff-set percent a percent', async () => {
    const written = (await call({
      ...creating('Checkpoint'),
      id: VERSION_ID,
      licensingSourceVersionId: null,
      storedFee: { licensingFee: 35, licensingFeeType: 'PercentOfCompute' },
      extraInput: { licensingFee: 35 },
    })) as { licensingFeeType?: string };
    expect(written.licensingFeeType).toBe('PercentOfCompute');
  });
});

// A staff-locked fee is the rate a licensor agreed with Civitai; the owner must not be able to change it
// over the wire, whatever the editor shows. Policy clears (POI, private, non-commercial base model) are
// the exception by decision: they stop charging rather than change the rate, and refusing them would
// strand the owner's save.
describe('upsertModelVersionHandler — a staff-locked licence fee', () => {
  const stored = {
    licensingFee: 0.25,
    licensingFeeType: 'PerImageBuzz',
    licensingFeeSettlementCurrency: 'Cash',
  };
  const save = (
    extraInput: Record<string, unknown>,
    { isModerator = false, baseModel = 'Anima' } = {}
  ) =>
    call({
      ...creating('Checkpoint'),
      id: VERSION_ID,
      baseModel,
      licensingSourceVersionId: null,
      isModerator,
      storedFee: { ...stored, licensingFeeLocked: true },
      extraInput: { ...stored, ...extraInput },
    }) as Promise<{ licensingFee?: number | null }>;

  it.each([
    ['raises the rate', { licensingFee: 0.5 }],
    ['lowers the rate', { licensingFee: 0.1 }],
    ['clears it', { licensingFee: 0 }],
    ['moves it to Buzz settlement', { licensingFeeSettlementCurrency: 'Buzz' }],
  ])('refuses an owner who %s', async (_label, change) => {
    await expect(save(change)).rejects.toThrow(/set by Civitai/);
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
  });

  it('saves an owner who re-sends the stored fee (the editor always does)', async () => {
    expect(await save({})).toMatchObject({ licensingFee: 0.25 });
  });

  it('lets a moderator change it', async () => {
    expect(await save({ licensingFee: 0.5 }, { isModerator: true })).toMatchObject({
      licensingFee: 0.5,
    });
  });

  it('lets a non-commercial base model clear it', async () => {
    const nonCommercial = Object.keys(baseModelLicenses).find(
      (k) =>
        baseModelLicenses[k as keyof typeof baseModelLicenses]?.nonCommercial &&
        !isHiddenBaseModel(k)
    );
    expect(nonCommercial).toBeDefined();
    await expect(
      save({ licensingFee: 0 }, { baseModel: nonCommercial as string })
    ).resolves.toBeDefined();
  });

  it('does not apply to an unlocked fee (control)', async () => {
    const written = (await call({
      ...creating('Checkpoint'),
      id: VERSION_ID,
      licensingSourceVersionId: null,
      storedFee: stored,
      extraInput: { ...stored, licensingFee: 0.5 },
    })) as { licensingFee?: number };
    expect(written.licensingFee).toBe(0.5);
  });
});

describe('upsertModelVersionHandler — the percent flag gates a change to percent, not a round-trip', () => {
  // The editors send the stored type back on every save, so a gate on the requested type alone would
  // make every percent version unsaveable the moment the flag is turned off again.
  it('saves an owner re-sending a stored percent while the flag is off', async () => {
    mockReadFliptBoolean.mockResolvedValue(false);
    const written = (await call({
      ...creating('Checkpoint'),
      id: VERSION_ID,
      licensingSourceVersionId: null,
      storedFee: { licensingFee: 35, licensingFeeType: 'PercentOfCompute' },
      extraInput: { licensingFee: 35, licensingFeeType: 'PercentOfCompute' },
    })) as { licensingFeeType?: string };
    expect(written.licensingFeeType).toBe('PercentOfCompute');
  });
});
