import type { ModelVersionTerms } from '@civitai/buzz';
import { describe, expect, it } from 'vitest';
import { EntityAccessPermission } from '~/server/common/enums';
import {
  isTrialExhaustedError,
  parseTrialMessage,
  pickGateForMessage,
  purchaseGateCandidates,
  resolvePurchaseGates,
} from '~/components/Generate/paid-access-gate';

const TRIAL: ModelVersionTerms = { generation: { price: 200, trialLimit: 5 } };
const FREE_GEN: ModelVersionTerms = { download: { price: 500 }, generation: { free: true } };
const BUNDLED: ModelVersionTerms = { download: { price: 500 } };

const resource = (
  id: number,
  overrides: {
    terms?: ModelVersionTerms | null;
    isOwnedByUser?: boolean;
    modelName?: string;
  } = {}
) => ({
  id,
  name: `v${id}`,
  paidAccess: overrides.terms === null ? null : { endsAt: null, terms: overrides.terms ?? TRIAL },
  isOwnedByUser: overrides.isOwnedByUser,
  model: { id: id * 10, name: overrides.modelName ?? `Model ${id}` },
});

const access = (id: number, permissions: number) => ({
  entityId: id,
  hasAccess: true,
  permissions,
});

describe('purchaseGateCandidates', () => {
  it('keeps only resources a viewer could still be sold generation access to', () => {
    const resources = [
      resource(1),
      resource(2, { terms: null }),
      resource(3, { terms: FREE_GEN }),
      resource(4, { isOwnedByUser: true }),
    ];

    expect(purchaseGateCandidates(resources, {}).map((r) => r.id)).toEqual([1]);
  });

  // Generation bundled with the download sells no generation tier, so there is no trial to spend and
  // nothing for this alert to offer — such a version is already refused upstream by `grantsGeneration`.
  it('skips a gate that bundles generation with the download', () => {
    expect(purchaseGateCandidates([resource(1, { terms: BUNDLED })], {})).toEqual([]);
  });

  it('asks nothing for a moderator, who bypasses every gate', () => {
    expect(purchaseGateCandidates([resource(1)], { isModerator: true })).toEqual([]);
  });
});

describe('resolvePurchaseGates', () => {
  it('drops a version whose generation access the viewer already bought', () => {
    const gates = resolvePurchaseGates(
      [resource(1), resource(2)],
      [
        access(1, EntityAccessPermission.EarlyAccessGeneration),
        access(2, EntityAccessPermission.EarlyAccessDownload),
      ],
      {}
    );

    // 2 bought DOWNLOAD only, which does not grant generation — it stays sellable.
    expect(gates.map((g) => g.modelVersionId)).toEqual([2]);
  });

  it('carries the generation price and the names the alert renders', () => {
    const [gate] = resolvePurchaseGates([resource(1, { modelName: 'Sulphur' })], [], {});

    expect(gate).toEqual({
      modelVersionId: 1,
      modelId: 10,
      modelName: 'Sulphur',
      versionName: 'v1',
      price: 200,
    });
  });

  it('returns nothing when access has not resolved and the viewer may already be a buyer', () => {
    expect(resolvePurchaseGates([], undefined, {})).toEqual([]);
  });
});

describe('parseTrialMessage', () => {
  it('reads the count out of the warning that arrives while trials remain', () => {
    expect(
      parseTrialMessage('You have 1 trial generations remaining with Luicelia Superdia - v1.0')
    ).toEqual({ remaining: 1 });
  });

  it('reads zero, which is the same sentence at the wall', () => {
    expect(parseTrialMessage('You have 0 trial generations remaining with Sulphur')).toEqual({
      remaining: 0,
    });
  });

  it('recognises a trial message carrying no count', () => {
    expect(parseTrialMessage('No trial generations remaining')).toEqual({ remaining: undefined });
  });

  it('is undefined for anything that is not about trials', () => {
    expect(parseTrialMessage('insufficientBuzz')).toBeUndefined();
    expect(parseTrialMessage('You have 3 generations remaining in your queue')).toBeUndefined();
    expect(parseTrialMessage(undefined)).toBeUndefined();
  });
});

describe('isTrialExhaustedError', () => {
  it('fires at zero', () => {
    expect(isTrialExhaustedError('You have 0 trial generations remaining with Sulphur')).toBe(true);
  });

  // The advance warning uses the SAME sentence, so matching the phrase alone claimed the trial was
  // spent while a generation was still free — and showed the red alert over a working form.
  it('does NOT fire while trials remain', () => {
    expect(isTrialExhaustedError('You have 1 trial generations remaining with Luicelia')).toBe(
      false
    );
    expect(isTrialExhaustedError('You have 5 trial generations remaining with Sulphur')).toBe(
      false
    );
  });

  it('treats a countless trial message as exhausted — only a refusal produces one on submit', () => {
    expect(isTrialExhaustedError('No trial generations remaining')).toBe(true);
  });

  it('does not fire on unrelated generation errors', () => {
    expect(isTrialExhaustedError('insufficientBuzz')).toBe(false);
    expect(isTrialExhaustedError('Your prompt was flagged')).toBe(false);
    expect(isTrialExhaustedError('You have 3 generations remaining in your queue')).toBe(false);
    expect(isTrialExhaustedError(undefined)).toBe(false);
  });
});

describe('pickGateForMessage', () => {
  const a = resolvePurchaseGates([resource(1, { modelName: 'Sulphur' })], [], {})[0];
  const b = resolvePurchaseGates([resource(2, { modelName: 'HappyHorse' })], [], {})[0];

  it('picks the gate the message names when several are selected', () => {
    expect(
      pickGateForMessage([a, b], 'You have 0 trial generations remaining with HappyHorse')
    ).toBe(b);
  });

  it('picks the only candidate when the message names nothing recognisable', () => {
    expect(
      pickGateForMessage([a], 'You have 0 trial generations remaining with Something Else')
    ).toBe(a);
  });

  it('picks nothing when two gates are selected and neither is named', () => {
    expect(pickGateForMessage([a, b], 'You have 0 trial generations remaining')).toBeUndefined();
  });

  it('picks nothing when there is nothing to sell', () => {
    expect(
      pickGateForMessage([], 'You have 0 trial generations remaining with Sulphur')
    ).toBeUndefined();
  });
});
