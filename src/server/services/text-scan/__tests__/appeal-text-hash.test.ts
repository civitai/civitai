import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  loadTextScanTextHash,
  stampModeratorTextScanRuling,
} from '~/server/services/text-scan/actions/appeal-text-hash';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';

const subject = (text: string, declared = {}) => ({
  fields: [
    { heading: 'Name', text },
    { heading: 'Description', text: 'x'.repeat(50_000) },
  ],
  declared,
});

beforeEach(() => vi.clearAllMocks());

describe('textScanTextHash', () => {
  it('depends on the text only, not on declared flags', () => {
    expect(textScanTextHash(subject('A', { poi: true }))).toBe(
      textScanTextHash(subject('A', { poi: false }))
    );
  });

  it('changes when the text changes, including past any maxInputChars cap', () => {
    expect(textScanTextHash(subject('A'))).not.toBe(textScanTextHash(subject('B')));
    const long = subject('A');
    const edited = {
      ...long,
      fields: [long.fields[0], { heading: 'Description', text: `${'x'.repeat(50_000)}y` }],
    };
    expect(textScanTextHash(long)).not.toBe(textScanTextHash(edited));
  });
});

// `~/server/services/text-scan/profiles` is the registry FILE; only the barrel registers profiles.
// Without the side-effect import every hash comes back null, and a grant with a null hash was a
// permanent exemption.
describe('loadTextScanTextHash', () => {
  it('registers the Model and Bounty profiles through the barrel', () => {
    expect(getTextScanProfile('Model')).toBeDefined();
    expect(getTextScanProfile('Bounty')).toBeDefined();
  });

  it('hashes the entity text read through the profile', async () => {
    dbMock.dbWrite.bounty.findMany.mockResolvedValue([
      { id: 9, userId: 5, name: 'B', description: null, nsfw: false, nsfwLevel: 1, poi: false },
    ]);
    const hash = await loadTextScanTextHash('Bounty', 9);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns null for an entity the profile cannot load', async () => {
    dbMock.dbWrite.bounty.findMany.mockResolvedValue([]);
    expect(await loadTextScanTextHash('Bounty', 9)).toBeNull();
  });
});

describe('stampModeratorTextScanRuling', () => {
  it('writes a moderator ruling on the current text for the label', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([
      {
        id: 7,
        userId: 5,
        name: 'M',
        description: null,
        nsfw: false,
        poi: false,
        minor: true,
        modelVersions: [],
      },
    ]);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    expect(await stampModeratorTextScanRuling({ modelId: 7, userId: 3, label: 'minor' })).toBe(
      true
    );

    const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(call[0] as TemplateStringsArray).join('?');
    expect(text).toContain(`'appealGranted', jsonb_build_object(`);
    expect(text).toContain(`'via', 'moderator'`);
    expect(call.slice(1)).toEqual(expect.arrayContaining(['minor', 3, 7]));
  });

  it('writes nothing and reports false when the text cannot be read', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([]);
    expect(await stampModeratorTextScanRuling({ modelId: 7, userId: 3, label: 'minor' })).toBe(
      false
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
