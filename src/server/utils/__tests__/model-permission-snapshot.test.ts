import { describe, expect, it } from 'vitest';
import { MODEL_PERMISSION_LOG_START } from '@civitai/shared/merge-permission';
import type {
  ModelPermissions,
  PermissionChangeEvent,
} from '~/server/utils/model-permission-snapshot';
import {
  buildPermissionSnapshots,
  permissionsChanged,
  reconstructPermissionSnapshots,
  stateAtCutover,
} from '~/server/utils/model-permission-snapshot';
import { CommercialUse } from '~/shared/utils/prisma/enums';

const MODEL = 71;
const ACTOR = 82;
const OLD_MODEL = new Date('2025-01-01T00:00:00Z');

const allowed: ModelPermissions = {
  allowNoCredit: true,
  allowCommercialUse: [CommercialUse.Image, CommercialUse.Rent],
  allowDerivatives: true,
  allowDifferentLicense: true,
};

describe('permissionsChanged', () => {
  it('sees a change to each field', () => {
    expect(permissionsChanged(allowed, { allowDerivatives: false })).toBe(true);
    expect(permissionsChanged(allowed, { allowDifferentLicense: false })).toBe(true);
    expect(permissionsChanged(allowed, { allowNoCredit: false })).toBe(true);
    expect(permissionsChanged(allowed, { allowCommercialUse: [CommercialUse.Image] })).toBe(true);
  });

  it('control: a save resending the same values, in any order, changes nothing', () => {
    expect(permissionsChanged(allowed, {})).toBe(false);
    expect(
      permissionsChanged(allowed, {
        ...allowed,
        allowCommercialUse: [CommercialUse.Rent, CommercialUse.Image],
      })
    ).toBe(false);
  });
});

describe('buildPermissionSnapshots', () => {
  const args = {
    modelId: MODEL,
    modelCreatedAt: OLD_MODEL,
    before: allowed,
    actorUserId: ACTOR,
    actorRole: 'owner',
  };

  it('writes nothing when the save changes no permission', () => {
    expect(
      buildPermissionSnapshots({ ...args, data: { ...allowed }, hasSnapshots: false })
    ).toEqual([]);
  });

  it("on a model's first recorded change, keeps the state it is leaving", () => {
    const rows = buildPermissionSnapshots({
      ...args,
      data: { allowDerivatives: false },
      hasSnapshots: false,
    });
    expect(rows).toEqual([
      {
        modelId: MODEL,
        effectiveAt: MODEL_PERMISSION_LOG_START,
        source: 'baseline',
        actorUserId: null,
        actorRole: null,
        ...allowed,
      },
      {
        modelId: MODEL,
        source: 'live',
        actorUserId: ACTOR,
        actorRole: 'owner',
        ...allowed,
        allowDerivatives: false,
      },
    ]);
  });

  it('dates the baseline to creation for a model newer than the log', () => {
    const created = new Date('2026-09-10T00:00:00Z');
    const [baseline] = buildPermissionSnapshots({
      ...args,
      modelCreatedAt: created,
      data: { allowDerivatives: false },
      hasSnapshots: false,
    });
    expect(baseline.effectiveAt).toEqual(created);
  });

  it('control: once history exists, writes only the new state', () => {
    const rows = buildPermissionSnapshots({
      ...args,
      data: { allowDerivatives: false },
      hasSnapshots: true,
    });
    expect(rows.map((r) => r.source)).toEqual(['live']);
  });
});

describe('reconstructPermissionSnapshots', () => {
  const at = (iso: string) => new Date(iso);
  const event = (
    createdAt: string,
    field: PermissionChangeEvent['field'],
    oldValue: string,
    newValue: string
  ): PermissionChangeEvent => ({
    createdAt: at(createdAt),
    field,
    oldValue,
    newValue,
    userId: ACTOR,
    actorRole: 'owner',
  });

  it('rebuilds the timeline: a baseline, then one row per save', () => {
    const end: ModelPermissions = {
      allowNoCredit: true,
      allowCommercialUse: [CommercialUse.Rent],
      allowDerivatives: false,
      allowDifferentLicense: false,
    };
    const rows = reconstructPermissionSnapshots({
      modelId: MODEL,
      modelCreatedAt: OLD_MODEL,
      stateAtEnd: end,
      // Out of order on purpose; two fields in one save share a timestamp.
      events: [
        event('2026-09-01T00:00:00Z', 'allowDifferentLicense', 'true', 'false'),
        event('2026-08-10T00:00:00Z', 'allowDerivatives', 'true', 'false'),
        event('2026-08-10T00:00:00Z', 'allowCommercialUse', '["Image","Rent"]', '["Rent"]'),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        effectiveAt: MODEL_PERMISSION_LOG_START,
        source: 'baseline',
        allowNoCredit: true,
        allowCommercialUse: ['Image', 'Rent'],
        allowDerivatives: true,
        allowDifferentLicense: true,
      }),
      expect.objectContaining({
        effectiveAt: at('2026-08-10T00:00:00Z'),
        source: 'backfill',
        actorUserId: ACTOR,
        allowCommercialUse: ['Rent'],
        allowDerivatives: false,
        allowDifferentLicense: true,
      }),
      expect.objectContaining({
        effectiveAt: at('2026-09-01T00:00:00Z'),
        allowDerivatives: false,
        allowDifferentLicense: false,
      }),
    ]);
  });

  it('writes nothing for a model with no logged change', () => {
    expect(
      reconstructPermissionSnapshots({
        modelId: MODEL,
        modelCreatedAt: OLD_MODEL,
        stateAtEnd: allowed,
        events: [],
      })
    ).toEqual([]);
  });

  it('refuses a value it cannot read rather than storing a guess', () => {
    expect(() =>
      reconstructPermissionSnapshots({
        modelId: MODEL,
        modelCreatedAt: OLD_MODEL,
        stateAtEnd: allowed,
        events: [event('2026-08-10T00:00:00Z', 'allowDerivatives', '"yes"', 'false')],
      })
    ).toThrow();
  });
});

describe('stateAtCutover', () => {
  it("takes a field changed since the cutover from that change's oldValue", () => {
    const current = { ...allowed, allowDerivatives: false };
    expect(
      stateAtCutover(current, [
        {
          createdAt: new Date('2026-11-02T00:00:00Z'),
          field: 'allowDerivatives',
          oldValue: 'false',
          newValue: 'true',
          userId: ACTOR,
          actorRole: 'owner',
        },
        {
          createdAt: new Date('2026-11-01T00:00:00Z'),
          field: 'allowDerivatives',
          oldValue: 'true',
          newValue: 'false',
          userId: ACTOR,
          actorRole: 'owner',
        },
      ])
    ).toEqual({ ...current, allowDerivatives: true });
  });

  it('control: with no later change it is the current state', () => {
    expect(stateAtCutover(allowed, [])).toEqual(allowed);
  });
});
