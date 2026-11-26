import { describe, expect, it } from 'vitest';
import {
  toCoverageUpdateDocument,
  toIndexedVersion,
  toIndexedVersions,
} from '~/server/search-index/models-index-versions';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';

const { PartnerService, PartnerTrains, NotEvictable, GenerationDisabled } = ModelVersionFlag;
const shown = { buzz: false, downloads: false, generations: false };

const version = (id: number, flags: number) =>
  ({
    id,
    name: `v${id}`,
    flags,
    baseModel: 'SDXL 1.0',
    nsfwLevel: 1,
    generatorLoaded: true,
    usageControl: 'Download',
    generationCoverage: { covered: true, coveredNext: true },
    files: [],
    hashes: [{ hash: 'abc', hashType: 'SHA256' }],
    settings: null,
    metrics: [{ downloadCount: 1, generationCount: 2, thumbsUpCount: 3, thumbsDownCount: 0 }],
    trainedWords: [],
  } as never);

const cases = [
  [
    'partner that trains, with other bits',
    PartnerService | PartnerTrains | NotEvictable,
    true,
    true,
  ],
  ['partner only', PartnerService | GenerationDisabled, true, false],
  ['no partner bits', NotEvictable, false, false],
] as const;

describe('models search document versions carry the disclosure, never the raw flags', () => {
  it.each(cases)('version: %s', (_, flags, partnerService, partnerTrains) => {
    const doc = toIndexedVersion(version(1, flags), shown);
    expect(doc).not.toHaveProperty('flags');
    expect(doc).toMatchObject({ id: 1, partnerService, partnerTrains });
  });

  it.each(cases)('versions[]: %s', (_, flags, partnerService, partnerTrains) => {
    const [doc] = toIndexedVersions([version(1, flags)], {
      hidden: shown,
      paidAccessTerms: new Map(),
      eligibility: [{ canGenerate: true, canGenerateNext: true }],
    });
    expect(doc).not.toHaveProperty('flags');
    expect(doc).toMatchObject({ id: 1, partnerService, partnerTrains });
  });

  it.each(cases)('moderator coverage reindex: %s', (_, flags, partnerService, partnerTrains) => {
    const update = toCoverageUpdateDocument({
      id: 10,
      type: 'Checkpoint',
      modelVersions: [version(1, flags), version(2, 0)],
    });
    expect(update?.version).not.toHaveProperty('flags');
    expect(update?.version).toMatchObject({ id: 1, partnerService, partnerTrains });
    expect(update?.versions.map((v) => 'flags' in v)).toEqual([false, false]);
    expect(update?.versions[0]).toMatchObject({ partnerService, partnerTrains });
    expect(update?.versions[1]).toMatchObject({ partnerService: false, partnerTrains: false });
  });
});
