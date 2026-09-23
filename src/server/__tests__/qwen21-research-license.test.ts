import { describe, expect, it } from 'vitest';
import {
  ECO,
  baseModelRecords,
  getActiveBaseModels,
  getGenerationSupport,
  licenses as sharedLicenses,
} from '@civitai/shared/basemodel.constants';
import {
  baseModelLicenses,
  getEffectiveCommercialUse,
  getRestrictedNsfwLevelsForBaseModel,
  isNonCommercialBaseModel,
} from '~/server/common/constants';
import type { BaseModel } from '@civitai/shared/basemodel.constants';
import { CommercialUse, ModelType } from '~/shared/utils/prisma/enums';

// The revision read on 2026-09-23 (HEAD of main then). The LICENSE was three days
// old, so `main` is not a stable record of the text we point creators at.
const PERMALINK =
  'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/790c92633540aa0cb11d9abf19eb46d861714758/LICENSE';

// Section 3(c), verbatim.
const NOTICE =
  'Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.';

function recordFor(ecosystemId: number) {
  const record = baseModelRecords.find((r) => r.ecosystemId === ecosystemId);
  if (!record) throw new Error(`no base-model record registered for ecosystem ${ecosystemId}`);
  return record;
}

const qwen21 = () => recordFor(ECO.Qwen21);
// Keyed by the record's live name: `BaseModel` is `string`, so a drifted key compiles.
const serverLicense = () => baseModelLicenses[qwen21().name as BaseModel];

describe('Qwen 2.1 base model', () => {
  it('is its own base model, offered in the upload picker', () => {
    expect(qwen21().name).toBe('Qwen 2.1');
    expect(getActiveBaseModels(false).map((m) => m.name)).toContain('Qwen 2.1');
  });

  // Qwen-Image 2.1 is an open-weight release distinct from the Qwen 2 (Qwen-Image
  // 2.0) API model. The reverse direction is unguarded until Qwen 2.1 has generation
  // support: getGenerationSupport returns null before consulting any cross rule.
  it('does not offer Qwen 2.1 resources to Qwen 2', () => {
    expect(getGenerationSupport(ECO.Qwen2, ECO.Qwen21, ModelType.LORA)).toBeNull();
  });
});

describe('Qwen 2.1 licence', () => {
  it('binds the research licence in the map the model page reads', () => {
    const license = serverLicense();
    expect(license, `no licence bound for base model '${qwen21().name}'`).toBeDefined();
    expect(license!.name).toBe('Qwen Research License Agreement');
  });

  it('points at a pinned revision of the licence text', () => {
    expect(serverLicense()!.url).toBe(PERMALINK);
  });

  it('carries the section 3(c) notice verbatim', () => {
    expect(serverLicense()!.notice).toBe(NOTICE);
  });

  it('keeps the two unsynced copies saying the same thing', () => {
    const shared = sharedLicenses.find((l) => l.id === qwen21().licenseId);
    expect(shared, `no shared licence record for id ${qwen21().licenseId}`).toBeDefined();
    const { id: _id, ...sharedFields } = shared!;
    expect(sharedFields).toEqual(serverLicense());
  });

  it('leaves Qwen and Qwen 2 on their existing licences', () => {
    expect(baseModelLicenses['Qwen']?.name).toBe('Apache 2.0');
    expect(recordFor(ECO.Qwen2).licenseId).toBe(13);
  });
});

// To whoever is about to add `nonCommercial: true` because the agreement says
// "non-commercial only": that flag withholds paid access and licensing fees from
// every Qwen 2.1 version. Whether to do that is a product decision that was
// deliberately NOT taken with this change, and the same holds for the mature and
// same-licence gates below. Change this test only alongside that decision.
describe('Qwen 2.1 licence display does not decide permissions', () => {
  it('sets no commercial or mature restriction on the licence', () => {
    const license = serverLicense()!;
    expect(license.nonCommercial).toBeUndefined();
    expect(license.disableMature).toBeUndefined();
    expect(license.restrictedNsfwLevels).toBeUndefined();
    expect(license.requiresSameLicense).toBeUndefined();
  });

  it("reads the creator's commercial permission through unchanged", () => {
    const name = qwen21().name;
    expect(isNonCommercialBaseModel(name)).toBe(false);
    expect(getEffectiveCommercialUse([CommercialUse.Sell], name)).toEqual([CommercialUse.Sell]);
    expect(getRestrictedNsfwLevelsForBaseModel(name)).toEqual([]);
  });
});
