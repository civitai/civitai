import { describe, expect, it } from 'vitest';
import { toCsv } from '~/utils/csv';

describe('toCsv', () => {
  it('writes a header row followed by the data rows', () => {
    expect(toCsv(['a', 'b'], [[1, 2]])).toBe('a,b\r\n1,2');
  });

  it('quotes values containing commas, quotes or newlines', () => {
    expect(toCsv(['v'], [['a,b'], ['say "hi"'], ['line\nbreak']])).toBe(
      'v\r\n"a,b"\r\n"say ""hi"""\r\n"line\nbreak"'
    );
  });

  it('neutralizes values a spreadsheet would treat as a formula', () => {
    expect(toCsv(['v'], [['=SUM(A1)'], ['+1'], ['-1'], ['@ref']])).toBe(
      "v\r\n'=SUM(A1)\r\n'+1\r\n'-1\r\n'@ref"
    );
  });

  it('renders empty cells for null and undefined', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,');
  });

  it('serializes dates as ISO 8601', () => {
    expect(toCsv(['d'], [[new Date('2026-07-20T18:28:05Z')]])).toBe(
      'd\r\n2026-07-20T18:28:05.000Z'
    );
  });
});
