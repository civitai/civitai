import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { newUlid } from '~/server/utils/app-block-ids';
import { isIdentifierShapedLeaf, sharedLeafFreeText } from '../shared-data-identifiers';

const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const UUID = '3f2b8c1e-9a4d-4e7f-b6c5-0d1e2f3a4b5c';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('isIdentifierShapedLeaf — positives', () => {
  it.each([
    ['ULID', ULID],
    ['ULID, max time char', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ'],
    ['UUID, lower case', UUID],
    ['UUID, upper case', UUID.toUpperCase()],
    ['UUID, nil', '00000000-0000-0000-0000-000000000000'],
    ['UUID, any version nibble', '3f2b8c1e-9a4d-7e7f-b6c5-0d1e2f3a4b5c'],
    ['32-hex digest', MD5],
    ['40-hex digest', SHA1],
    ['64-hex digest', SHA256],
    ['upper-case hex digest', SHA1.toUpperCase()],
    ['decimal integer', '1234567'],
    ['single digit', '0'],
    ['20-digit integer', '12345678901234567890'],
    ['label:ULID', `playcount:${ULID}`],
    ['label:UUID', `likes:${UUID}`],
    ['label:digest', `sha:${SHA256}`],
    ['label:integer', 'views:42'],
    ['label:integer:ULID', `votes:12:${ULID}`],
    ['label:label:ULID', `round:entry:${ULID}`],
    ['label with digits, _ and -', `best_of-3:${ULID}`],
    ['32-char label', `${'a'.repeat(32)}:${ULID}`],
    ['surrounding whitespace is trimmed', `  ${ULID}\n`],
  ])('%s', (_, text) => {
    expect(isIdentifierShapedLeaf(text)).toBe(true);
  });

  it('accepts what the real generators emit', () => {
    for (let i = 0; i < 200; i++) {
      expect(isIdentifierShapedLeaf(newUlid())).toBe(true);
      expect(isIdentifierShapedLeaf(randomUUID())).toBe(true);
      expect(isIdentifierShapedLeaf(`plays:${newUlid()}`)).toBe(true);
    }
  });
});

describe('isIdentifierShapedLeaf — negatives', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a word', 'hello'],
    ['a sentence', 'a quiet harbor at dawn'],
    ['a sentence containing a ULID', `my id is ${ULID}`],
    ['a ULID with trailing words', `${ULID} and more`],
    ['a ULID with leading words', `see ${ULID}`],
    ['a ULID then a newline and words', `${ULID}\nhello`],
    ['two ULIDs joined by a space', `${ULID} ${ULID}`],
    ['two ULIDs run together', `${ULID}${ULID}`],
    ['ULID and UUID joined by a dash', `${ULID}-${UUID}`],
    ['comma-separated ids', `${ULID},${ULID}`],
    ['25-char ULID', ULID.slice(0, 25)],
    ['27-char ULID', `${ULID}0`],
    ['lower-case ULID', ULID.toLowerCase()],
    ['ULID with I', `01JABCDEFGHIKMNPQRSTVWXYZ0`],
    ['ULID with L', `01JABCDEFGHLKMNPQRSTVWXYZ0`],
    ['ULID with O', `01JABCDEFGHOKMNPQRSTVWXYZ0`],
    ['ULID with U', `01JABCDEFGHUKMNPQRSTVWXYZ0`],
    ['ULID past the 48-bit time range', `8${ULID.slice(1)}`],
    ['ULID with a full-width digit', `０${ULID.slice(1)}`],
    ['UUID without one group', UUID.split('-').slice(0, 4).join('-')],
    ['UUID with a short last group', UUID.slice(0, -1)],
    ['UUID in braces', `{${UUID}}`],
    ['UUID with a non-hex char', `${UUID.slice(0, -1)}g`],
    ['UUID with misplaced dashes', '3f2b8c1e9-a4d-4e7f-b6c5-0d1e2f3a4b5c'],
    ['31-hex', MD5.slice(0, 31)],
    ['33-hex', `${MD5}0`],
    ['39-hex', SHA1.slice(0, 39)],
    ['41-hex', `${SHA1}0`],
    ['63-hex', SHA256.slice(0, 63)],
    ['65-hex', `${SHA256}0`],
    ['48-hex (not a digest length)', SHA256.slice(0, 48)],
    ['40 chars with a non-hex letter', `${SHA1.slice(0, 39)}x`],
    ['negative integer', '-5'],
    ['decimal fraction', '1.5'],
    ['exponent', '1e5'],
    ['thousands separator', '1,000'],
    ['21-digit integer', '123456789012345678901'],
    ['upper-case label', `Plays:${ULID}`],
    ['label starting with a digit', `9plays:${ULID}`],
    ['label with a space', `play count:${ULID}`],
    ['label with a dot', `a.b:${ULID}`],
    ['33-char label', `${'a'.repeat(33)}:${ULID}`],
    ['empty label', `:${ULID}`],
    ['label only', 'plays:'],
    ['empty segment between label and id', `plays::${ULID}`],
    ['trailing colon', `plays:${ULID}:`],
    ['words after the id', `plays:${ULID}:extra`],
    ['label after an id', `12:votes:${ULID}`],
    ['id then a label', `${ULID}:plays`],
    ['a space around the colon', `plays: ${ULID}`],
    ['more than four segments', `a:b:c:1:${ULID}`],
    ['label made of free text', `this is fine:${ULID}`],
  ])('%s', (_, text) => {
    expect(isIdentifierShapedLeaf(text)).toBe(false);
  });

  it('four segments is the limit', () => {
    expect(isIdentifierShapedLeaf(`a:b:1:${ULID}`)).toBe(true);
    expect(isIdentifierShapedLeaf(`a:b:c:1:${ULID}`)).toBe(false);
  });
});

describe('sharedLeafFreeText — what the free-text audits still read', () => {
  it.each([
    ['a bare ULID reads as nothing', ULID, ''],
    ['a bare UUID reads as nothing', UUID, ''],
    ['a bare digest reads as nothing', SHA1, ''],
    ['a bare integer reads as nothing', '1234567', ''],
    ['the label of a counter key is kept', `playcount:${ULID}`, 'playcount'],
    ['only the label of a nested key is kept', `votes:12:${UUID}`, 'votes'],
    ['two labels are both kept', `round:entry:${ULID}`, 'round:entry'],
    ['surrounding whitespace is trimmed', ` ${ULID} `, ''],
    ['a non-identifier leaf is returned unchanged', `my id is ${ULID}`, `my id is ${ULID}`],
    ['an upper-case-label leaf is returned unchanged', `Plays:${ULID}`, `Plays:${ULID}`],
    ['the empty string stays empty', '', ''],
  ])('%s', (_, text, expected) => {
    expect(sharedLeafFreeText(text)).toBe(expected);
  });
});
