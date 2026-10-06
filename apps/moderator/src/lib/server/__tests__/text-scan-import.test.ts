import { describe, expect, it } from 'vitest';
import { MISSING_HEADING, normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseSeedFile, SeedFileError } from '../text-scan-lab/seed-file';

const entityCase = (over: Record<string, unknown> = {}) => ({
  entityType: 'Model',
  entityId: 101,
  expected: { nsfw: { min: 'none', max: 'pg13' }, minor: true, poi: false },
  ...over,
});
const textCase = (over: Record<string, unknown> = {}) => ({
  entityType: 'Comment',
  fields: [{ heading: 'Comment', text: 'FAKE COMMENT' }],
  expected: { scam: true },
  synthetic: true,
  note: 'seeded',
  ...over,
});

const errorsOf = (json: unknown): string[] => {
  try {
    parseSeedFile(json);
  } catch (e) {
    if (e instanceof SeedFileError) return e.problems;
    throw e;
  }
  throw new Error('expected parseSeedFile to throw');
};

describe('parseSeedFile', () => {
  it('parses entity and free-text cases', () => {
    expect(parseSeedFile({ cases: [entityCase(), textCase()] })).toEqual([
      {
        kind: 'entity',
        entityType: 'Model',
        entityId: 101,
        expected: { nsfw: { min: 'none', max: 'pg13' }, minor: true, poi: false },
        synthetic: false,
        note: null,
      },
      {
        kind: 'text',
        entityType: 'Comment',
        fields: [{ heading: 'Comment', text: 'FAKE COMMENT' }],
        expected: { scam: true },
        synthetic: true,
        note: 'seeded',
      },
    ]);
  });

  it('accepts an empty expectation (nothing scored yet)', () => {
    expect(parseSeedFile({ cases: [entityCase({ expected: {} })] })[0].expected).toEqual({});
  });

  it('rejects a file without a cases array, or with none', () => {
    expect(errorsOf([])).toEqual([expect.stringMatching(/cases/)]);
    expect(errorsOf({ cases: [] })).toEqual([expect.stringMatching(/no cases/)]);
  });

  it('rejects an unknown nsfw level', () => {
    expect(
      errorsOf({ cases: [entityCase({ expected: { nsfw: { min: 'pg', max: 'r' } } })] })
    ).toEqual([expect.stringMatching(/^case 1 .*Unknown nsfw level pg/)]);
  });

  it('rejects an nsfw min above its max', () => {
    expect(
      errorsOf({ cases: [entityCase({ expected: { nsfw: { min: 'xxx', max: 'r' } } })] })
    ).toEqual([expect.stringMatching(/min xxx is above max r/)]);
  });

  it('rejects a label the entity type does not score', () => {
    expect(errorsOf({ cases: [textCase({ expected: { nsfw: { min: 'r', max: 'r' } } })] })).toEqual(
      [expect.stringMatching(/Cannot expect nsfw/)]
    );
  });

  it('rejects a case with neither entityId nor fields', () => {
    const { entityId: _, ...neither } = entityCase();
    expect(errorsOf({ cases: [neither] })).toEqual([
      expect.stringMatching(/^case 1 .*entityId or fields/),
    ]);
  });

  it('keeps a pre-composed snapshot on an entity case', () => {
    const fields = [{ heading: 'Name', text: 'FAKE MODEL' }];
    expect(parseSeedFile({ cases: [entityCase({ fields, authorId: 7 })] })[0]).toMatchObject({
      kind: 'entity',
      entityId: 101,
      fields,
      authorId: 7,
    });
    expect(
      errorsOf({
        cases: [entityCase({ authorId: 7 }), entityCase({ entityId: 102, fields, authorId: 0 })],
      })
    ).toEqual([
      expect.stringMatching(/^case 1 .*authorId goes with/),
      expect.stringMatching(/^case 2 .*authorId 0/),
    ]);
    expect(errorsOf({ cases: [entityCase({ fields: [{ heading: 'Name', text: ' ' }] })] })).toEqual(
      [expect.stringMatching(/^case 1 .*no text/)]
    );
  });

  it('drops a field whose text is null, as a composed snapshot has for an absent field', () => {
    const fields = [
      { heading: 'Name', text: 'FAKE MODEL' },
      { heading: 'Description', text: null },
    ];
    expect(parseSeedFile({ cases: [entityCase({ fields })] })[0]).toMatchObject({
      fields: [{ heading: 'Name', text: 'FAKE MODEL' }],
    });
    expect(errorsOf({ cases: [entityCase({ fields: [{ heading: 'Name', text: 3 }] })] })).toEqual([
      expect.stringMatching(/^case 1 .*array of \{ heading, text \}/),
    ]);
  });

  it('rejects fields that carry no text, or text without a heading', () => {
    expect(
      errorsOf({
        cases: [
          textCase({ fields: [{ heading: 'Comment', text: '  ' }] }),
          textCase({ fields: [{ heading: ' ', text: 'FAKE' }] }),
        ],
      })
    ).toEqual([
      expect.stringMatching(/^case 1 .*no text/),
      expect.stringMatching(/^case 2 .*heading/),
    ]);
  });

  it('rejects an unknown entity type and a bad entity id', () => {
    expect(
      errorsOf({
        cases: [
          entityCase({ entityType: 'Image' }),
          entityCase({ entityId: 0 }),
          entityCase({ entityId: 2 ** 31 }),
        ],
      })
    ).toEqual([
      expect.stringMatching(/^case 1 .*Unknown entity type Image/),
      expect.stringMatching(/^case 2 .*entityId/),
      expect.stringMatching(/^case 3 .*entityId/),
    ]);
  });

  it('rejects the same entity twice, since the second would overwrite the first', () => {
    expect(errorsOf({ cases: [entityCase(), entityCase({ expected: {} })] })).toEqual([
      expect.stringMatching(/^case 2 .*Model 101 is already case 1/),
    ]);
  });

  it('rejects a non-boolean synthetic, a non-string note and one over the column limit', () => {
    expect(
      errorsOf({
        cases: [
          textCase({ synthetic: 'yes' }),
          textCase({ note: 7 }),
          textCase({ note: 'n'.repeat(1001) }),
        ],
      })
    ).toEqual([
      expect.stringMatching(/^case 1 .*synthetic/),
      expect.stringMatching(/^case 2 .*note/),
      expect.stringMatching(/^case 3 .*note is over 1000/),
    ]);
  });

  it('reports every bad case, not just the first', () => {
    expect(
      errorsOf({
        cases: [
          entityCase({ expected: { nsfw: { min: 'x', max: 'r' } } }),
          entityCase({ entityId: 102 }),
          textCase({ fields: [] }),
        ],
      })
    ).toEqual([expect.stringMatching(/^case 1 /), expect.stringMatching(/^case 3 /)]);
  });
});

describe('normaliseLabFields', () => {
  it('drops null, missing and blank text and trims headings, keeping text as given', () => {
    expect(
      normaliseLabFields([
        { heading: ' Name ', text: ' FAKE MODEL ' },
        { heading: 'Description', text: null },
        { heading: 'Trained words' },
        { heading: 'Version', text: '  ' },
      ])
    ).toEqual([{ heading: 'Name', text: ' FAKE MODEL ' }]);
  });

  it('refuses text without a heading, and ignores a headingless field with no text', () => {
    expect(normaliseLabFields([{ heading: ' ', text: 'FAKE' }])).toBe(MISSING_HEADING);
    expect(normaliseLabFields([{ heading: '', text: null }])).toEqual([]);
  });
});
