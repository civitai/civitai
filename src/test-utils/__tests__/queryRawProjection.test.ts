import { describe, expect, it } from 'vitest';
import {
  projectOntoSelect,
  respondWithRows,
  selectedColumns,
} from '~/test-utils/queryRawProjection';

/**
 * Validates the INSTRUMENT before any suite reads a verdict from it.
 *
 * The helper's whole job is to DROP a column the statement did not select. A projection that
 * silently passed rows through would look identical from a passing suite, so the negative
 * control below (a column that must NOT survive) is the load-bearing case here.
 */

const stmt = (sql: string) => [sql, ''] as unknown as TemplateStringsArray;

const IMAGE_SELECT = stmt(`
  SELECT
    id,
    url,
    "hideMeta",
    type,
    "mimeType"
  FROM "Image"
  WHERE url = `);

const LEGACY_SELECT = stmt(`
  SELECT
    id,
    url,
    "hideMeta"
  FROM "Image"
  WHERE url = `);

const ROW = {
  id: 1,
  url: 'a/b.mp4',
  hideMeta: false,
  type: 'video',
  mimeType: 'video/mp4',
  userId: 99,
};

describe('selectedColumns', () => {
  it('reads the SELECT list, unquoting identifiers', () => {
    expect(selectedColumns(IMAGE_SELECT)).toEqual(['id', 'url', 'hideMeta', 'type', 'mimeType']);
  });

  it('reports an aliased expression under its alias', () => {
    expect(selectedColumns(stmt('SELECT id, "mimeType" AS "mime" FROM "Image"'))).toEqual([
      'id',
      'mime',
    ]);
  });

  it('reports SELECT * as *', () => {
    expect(selectedColumns(stmt('SELECT * FROM "Image"'))).toEqual(['*']);
  });

  it('THROWS rather than guessing when there is no SELECT list', () => {
    expect(() => selectedColumns(stmt('UPDATE "Image" SET x = 1'))).toThrow(
      /could not find a SELECT/
    );
  });
});

describe('projectOntoSelect', () => {
  it('NEGATIVE CONTROL: drops a column the statement did not select', () => {
    // `userId` is on the fixture and not in the SELECT list — it must not survive. If this
    // ever passes through, every suite built on this helper becomes vacuous.
    const [projected] = projectOntoSelect(IMAGE_SELECT, [ROW]);
    expect(projected).not.toHaveProperty('userId');
    expect(Object.keys(projected).sort()).toEqual(
      ['hideMeta', 'id', 'mimeType', 'type', 'url'].sort()
    );
  });

  it('NEGATIVE CONTROL: a narrower SELECT yields a narrower row', () => {
    // This is precisely the pre-change image-delivery statement. The media-type fields must
    // be absent, which is what makes an assertion on them genuinely red against that code.
    const [projected] = projectOntoSelect(LEGACY_SELECT, [ROW]);
    expect(projected).not.toHaveProperty('type');
    expect(projected).not.toHaveProperty('mimeType');
    expect(projected).toEqual({ id: 1, url: 'a/b.mp4', hideMeta: false });
  });

  it('POSITIVE CONTROL: keeps every selected column, values intact', () => {
    expect(projectOntoSelect(IMAGE_SELECT, [ROW])[0]).toEqual({
      id: 1,
      url: 'a/b.mp4',
      hideMeta: false,
      type: 'video',
      mimeType: 'video/mp4',
    });
  });

  it('keeps a key that is explicitly undefined (presence, not definedness)', () => {
    const row = { ...ROW, mimeType: undefined };
    const [projected] = projectOntoSelect(IMAGE_SELECT, [row]);
    expect(Object.keys(projected)).toContain('mimeType');
    expect(projected.mimeType).toBeUndefined();
  });

  it('keeps a null column as null', () => {
    const [projected] = projectOntoSelect(IMAGE_SELECT, [{ ...ROW, mimeType: null }]);
    expect(projected.mimeType).toBeNull();
  });

  it('THROWS, naming the column, when the fixture does not model a selected column', () => {
    const incomplete = { id: 1, url: 'a/b.mp4', hideMeta: false, type: 'video' };
    expect(() => projectOntoSelect(IMAGE_SELECT, [incomplete])).toThrow(/selects "mimeType"/);
  });

  it('projects every row, and an empty result set stays empty', () => {
    expect(projectOntoSelect(IMAGE_SELECT, [])).toEqual([]);
    expect(projectOntoSelect(IMAGE_SELECT, [ROW, { ...ROW, id: 2 }])).toHaveLength(2);
  });
});

describe('respondWithRows', () => {
  it('resolves the projected rows', async () => {
    await expect(respondWithRows([ROW])(LEGACY_SELECT)).resolves.toEqual([
      { id: 1, url: 'a/b.mp4', hideMeta: false },
    ]);
  });
});
