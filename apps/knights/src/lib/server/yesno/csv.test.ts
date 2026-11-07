import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const rows = parseCsv('id,text,flag\r\na,"one, ""two""\nthree",x\r\nb,plain,y\r\n');
    expect(rows).toEqual([
      { id: 'a', text: 'one, "two"\nthree', flag: 'x' },
      { id: 'b', text: 'plain', flag: 'y' },
    ]);
  });

  it('drops a byte order mark, blank lines, and fills a short row with empty values', () => {
    expect(parseCsv('﻿a,b\n\n1\n')).toEqual([{ a: '1', b: '' }]);
  });

  it('is empty for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
