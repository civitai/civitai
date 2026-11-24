import { describe, expect, it } from 'vitest';
import {
  escapeData,
  escapeProperty,
  formatAnnotations,
  MAX_ERROR_ANNOTATIONS,
  selectBlockingDiagnostics,
} from '../ci/typecheck-tests-annotations.mjs';

type Diag = { file: string; line: number; col: number; code: number; message: string };
const d = (file: string, line: number, code = 2322, message = `m${line}`, col = 1): Diag => ({
  file,
  line,
  col,
  code,
  message,
});

const NEW_A = 'src/a/__tests__/new-a.test.ts';
const NEW_B = 'src/b/__tests__/new-b.test.ts';
const WORSE = 'src/w/__tests__/worse.test.ts';
const OLD = 'src/o/__tests__/old.test.ts';

const blocked = (newly: string[], worsened: { file: string; was: number; now: number }[] = []) => ({
  blocked: true,
  newlyDirty: newly.map((file) => ({ file, count: 0 })),
  worsened,
});

describe('escaping (GitHub workflow-command rules)', () => {
  it('escapes % CR LF in data, and also : , in properties', () => {
    expect(escapeData('100%\r\nok: a,b')).toBe('100%25%0D%0Aok: a,b');
    expect(escapeProperty('C:\\x,y%\n')).toBe('C%3A\\x%2Cy%25%0A');
  });
});

describe('selectBlockingDiagnostics', () => {
  it('new files first, round-robin across files, worsened files after, baseline-only files never', () => {
    const diags = [
      d(OLD, 1),
      d(WORSE, 9),
      d(NEW_B, 20),
      d(NEW_A, 30),
      d(NEW_A, 10),
      d(NEW_B, 5),
      d(WORSE, 3),
    ];
    const picked = selectBlockingDiagnostics(
      diags,
      blocked([NEW_A, NEW_B], [{ file: WORSE, was: 1, now: 2 }])
    );
    expect(
      picked.map((p: { diagnostic: Diag }) => `${p.diagnostic.file}:${p.diagnostic.line}`)
    ).toEqual([
      `${NEW_A}:10`,
      `${NEW_B}:5`,
      `${NEW_A}:30`,
      `${NEW_B}:20`,
      `${WORSE}:3`,
      `${WORSE}:9`,
    ]);
    expect(picked[4].worsened).toEqual({ was: 1, now: 2 });
    expect(picked[0].worsened).toBeNull();
  });
});

describe('formatAnnotations', () => {
  it('prints one ::error per blocking diagnostic with file, line, col, TS code and an escaped message', () => {
    const lines = formatAnnotations({
      diagnostics: [
        d(NEW_A, 7, 2345, "Argument of type '100%' is not assignable.\n  Details: here", 13),
        d(OLD, 1),
      ],
      result: blocked([NEW_A]),
    });
    expect(lines).toEqual([
      `::error file=${NEW_A},line=7,col=13,title=TS2345::Argument of type '100%25' is not assignable.%0A  Details: here`,
    ]);
  });

  it('says a worsened-file error may be a pre-existing one', () => {
    const lines = formatAnnotations({
      diagnostics: [d(WORSE, 4, 2304, 'Cannot find name.')],
      result: blocked([], [{ file: WORSE, was: 3, now: 4 }]),
    });
    expect(lines).toEqual([
      `::error file=${WORSE},line=4,col=1,title=TS2304::Cannot find name.%0A(Baselined file, 3 -> 4 errors: ` +
        'the gate counts per file, so this may be one of the existing ones.)',
    ]);
  });

  it('caps ::error lines at 10, lists the rest as plain lines, and ends with a count', () => {
    expect(MAX_ERROR_ANNOTATIONS).toBe(10);
    const diags = Array.from({ length: 13 }, (_, i) =>
      d(NEW_A, i + 1, 2322, `msg ${i + 1}\n  chain`)
    );
    const lines = formatAnnotations({ diagnostics: diags, result: blocked([NEW_A]) });
    expect(lines.filter((l: string) => l.startsWith('::error'))).toHaveLength(10);
    expect(lines.slice(10)).toEqual([
      'typecheck-tests-gate: 3 more blocking diagnostic(s), not annotated:',
      `${NEW_A}:11:1 TS2322 msg 11`,
      `${NEW_A}:12:1 TS2322 msg 12`,
      `${NEW_A}:13:1 TS2322 msg 13`,
      '::notice title=typecheck-tests-gate::3 more blocking type error(s) are listed in the job log ' +
        '(GitHub keeps 10 error annotations per step).',
    ]);
  });

  it('prints exactly 10 and no overflow lines at the boundary', () => {
    const diags = Array.from({ length: 10 }, (_, i) => d(NEW_A, i + 1));
    const lines = formatAnnotations({ diagnostics: diags, result: blocked([NEW_A]) });
    expect(lines).toHaveLength(10);
    expect(lines.every((l: string) => l.startsWith('::error'))).toBe(true);
  });

  it('prints nothing when the gate did not block', () => {
    expect(
      formatAnnotations({
        diagnostics: [d(NEW_A, 1)],
        result: { ...blocked([NEW_A]), blocked: false },
      })
    ).toEqual([]);
  });
});
