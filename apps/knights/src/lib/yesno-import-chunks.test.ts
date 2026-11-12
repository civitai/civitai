// Temporary: remove after the Knights v2 launch import
import { describe, expect, it } from 'vitest';
import { parseCsv } from './server/yesno/csv';
import { splitCsv } from './yesno-import-chunks';

const HEADER = 'question_id,question,active_candidate';
const row = (n: number, question = `Q${n}`) =>
  `${n},${/[",\n]/.test(question) ? `"${question.replace(/"/g, '""')}"` : question},true`;
const body = (rows: string[]) => [HEADER, ...rows].join('\n');

const BOM = String.fromCharCode(0xfeff);

describe('splitCsv', () => {
  it('repeats the header in every chunk and keeps every row', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i));
    const { chunks, rows: total } = splitCsv(body(rows), { maxRows: 4 });
    expect(chunks.map((c) => c.rows)).toEqual([4, 4, 2]);
    expect(total).toBe(10);
    for (const chunk of chunks) expect(chunk.csv.split('\n')[0]).toBe(HEADER);
    const ids = chunks.flatMap((c) => parseCsv(c.csv).map((r) => r.question_id));
    expect(ids).toEqual(rows.map((_, i) => String(i)));
  });

  it('never splits a quoted field with commas, doubled quotes or newlines', () => {
    const tricky = [
      row(0, 'Is a "hat", worn?'),
      row(1, 'line one\nline two\n\nline four'),
      row(2, 'ends with quote ""'),
      row(3),
    ];
    const { chunks } = splitCsv(body(tricky), { maxRows: 1 });
    expect(chunks).toHaveLength(4);
    const parsed = chunks.flatMap((c) => parseCsv(c.csv));
    expect(parsed.map((r) => r.question)).toEqual([
      'Is a "hat", worn?',
      'line one\nline two\n\nline four',
      'ends with quote ""',
      'Q3',
    ]);
  });

  it('handles CRLF, a BOM and a missing final newline', () => {
    const text = `${BOM}${HEADER}\r\n${row(0)}\r\n${row(1)}\r\n`;
    const { chunks, rows } = splitCsv(text, { maxRows: 1 });
    expect(rows).toBe(2);
    expect(chunks.flatMap((c) => parseCsv(c.csv).map((r) => r.question_id))).toEqual(['0', '1']);
  });

  it('also cuts a chunk when it would pass the byte cap', () => {
    const big = 'x'.repeat(100);
    const { chunks, rows } = splitCsv(body([row(0, big), row(1, big), row(2, big)]), {
      maxRows: 400,
      maxBytes: 250,
    });
    expect(rows).toBe(3);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(new TextEncoder().encode(chunk.csv).length).toBeLessThanOrEqual(250);
  });

  it('returns no chunks for an empty file or a header only', () => {
    expect(splitCsv('', {})).toEqual({ chunks: [], rows: 0 });
    expect(splitCsv(`${HEADER}\n`, {})).toEqual({ chunks: [], rows: 0 });
  });

  it('refuses an unterminated quote instead of sending a broken chunk', () => {
    expect(() => splitCsv(body([row(0), '1,"never closed,true']), {})).toThrow(/quote/i);
  });
});
