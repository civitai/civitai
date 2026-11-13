/**
 * Unified-diff → RENDERABLE ROWS, with old/new line numbers resolved.
 *
 * The server already emits exactly the right shape (`structuredPatch` hunks from jsdiff,
 * via `computeBundleLineDiff`): each hunk carries `oldStart`/`newStart` and a list of
 * `' '`/`'+'`/`'-'`-prefixed lines. What a GitHub-shaped viewer needs on top of that is the
 * per-line NUMBER in each side's file, and that is a walk, not a render — so it lives here,
 * pure and React-free, and runs in the node-env `unit` project.
 *
 * 🔴 NO NEW RUNTIME DEPENDENCY, DELIBERATELY. `react-diff-view` would need these hunks
 * re-serialised to unified text and re-parsed to get back the structure we were already
 * handed, and this is a PUBLIC repo where a new runtime dep carries bundle weight plus a
 * maintenance surface. The only diff dep in `package.json` stays `diff@4.0.2` (jsdiff),
 * which is server-side.
 */

/** One hunk of a `FileLineDiff` — structurally the server's shape. */
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

/**
 * What a rendered line IS.
 *
 * `meta` is jsdiff's `\ No newline at end of file` marker, which belongs to NEITHER file's
 * numbering: it is a note about the preceding line. Treating it as context (the obvious
 * shortcut) advances both counters and silently shifts every number after it by one.
 */
export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

export type DiffUnifiedRow =
  | { kind: 'hunk'; key: string; label: string }
  | {
      kind: DiffLineKind;
      key: string;
      /** 1-based line number in the OLD file, or null (an addition / a meta marker). */
      oldNo: number | null;
      /** 1-based line number in the NEW file, or null (a deletion / a meta marker). */
      newNo: number | null;
      /** The line WITHOUT its diff sigil. */
      text: string;
      /**
       * The line AS THE SERVER SENT IT, sigil included.
       *
       * 🔴 THIS IS WHAT THE VIEWER RENDERS, and the reason both forms are carried. A
       * sigil-stripped code column loses the one signal that survives a colour-blind
       * reader, a screenshot in a bug report, and a copy-paste out of the page — GitHub's
       * own split and unified views both keep it. `text` exists because the NUMBERING walk
       * and any future word-level diff need the content without it, and deriving one from
       * the other at the call site is how the two drift.
       */
      raw: string;
    };

/** The `@@ -a,b +c,d @@` range header for a hunk. */
export function hunkRangeLabel(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** Classify a raw diff line by its leading sigil. An EMPTY line is context. */
export function diffLineKind(line: string): DiffLineKind {
  const sigil = line.charAt(0);
  if (sigil === '+') return 'add';
  if (sigil === '-') return 'del';
  if (sigil === '\\') return 'meta';
  return 'context';
}

/** A raw diff line minus its sigil. An empty line stays empty rather than becoming `-1`. */
function stripSigil(line: string, kind: DiffLineKind): string {
  if (kind === 'meta') return line;
  return line.length > 0 ? line.slice(1) : '';
}

/**
 * The UNIFIED rows for a file's hunks: a range header per hunk, then one row per line
 * carrying both line numbers.
 *
 * The walk is the whole content of this module: a context line advances BOTH counters, an
 * addition advances only the new one, a deletion only the old one, and a `meta` marker
 * advances neither.
 */
export function unifiedDiffRows(hunks: DiffHunk[]): DiffUnifiedRow[] {
  const rows: DiffUnifiedRow[] = [];
  hunks.forEach((hunk, hi) => {
    rows.push({ kind: 'hunk', key: `h${hi}`, label: hunkRangeLabel(hunk) });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    hunk.lines.forEach((line, li) => {
      const kind = diffLineKind(line);
      const text = stripSigil(line, kind);
      const key = `h${hi}l${li}`;
      if (kind === 'context') {
        rows.push({ kind, key, oldNo, newNo, text, raw: line });
        oldNo += 1;
        newNo += 1;
      } else if (kind === 'add') {
        rows.push({ kind, key, oldNo: null, newNo, text, raw: line });
        newNo += 1;
      } else if (kind === 'del') {
        rows.push({ kind, key, oldNo, newNo: null, text, raw: line });
        oldNo += 1;
      } else {
        rows.push({ kind, key, oldNo: null, newNo: null, text, raw: line });
      }
    });
  });
  return rows;
}

/** One side of a split row. `empty` is the filler opposite an unpaired add/delete. */
export type DiffSplitCell = {
  kind: 'context' | 'add' | 'del' | 'meta' | 'empty';
  no: number | null;
  /** The cell's content WITHOUT its diff sigil. */
  text: string;
  /** The cell's content as the server sent it (sigil included) — what is rendered. */
  raw: string;
};

export type DiffSplitRow =
  | { kind: 'hunk'; key: string; label: string }
  | { kind: 'pair'; key: string; left: DiffSplitCell; right: DiffSplitCell };

const EMPTY_CELL: DiffSplitCell = { kind: 'empty', no: null, text: '', raw: '' };

/**
 * The SPLIT (side-by-side) rows for a file's hunks.
 *
 * 🔴 DELETIONS AND ADDITIONS ARE PAIRED PER CONTIGUOUS RUN, not one-to-one across the
 * whole hunk. A unified hunk emits every `-` of an edit before every `+`, so pairing them
 * as they arrive would put each removal opposite a context line. Instead each run of
 * `-`/`+` immediately preceding a context line (or the hunk end) is flushed together: row
 * `i` of the run shows `del[i]` on the left and `add[i]` on the right, and the shorter
 * side gets `empty` filler. That is what makes a 3-line → 1-line edit read as one changed
 * block with two blank rows rather than as six unrelated rows.
 */
export function splitDiffRows(hunks: DiffHunk[]): DiffSplitRow[] {
  const rows: DiffSplitRow[] = [];
  hunks.forEach((hunk, hi) => {
    rows.push({ kind: 'hunk', key: `h${hi}`, label: hunkRangeLabel(hunk) });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let dels: DiffSplitCell[] = [];
    let adds: DiffSplitCell[] = [];
    let runIndex = 0;

    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        rows.push({
          kind: 'pair',
          key: `h${hi}r${runIndex}p${i}`,
          left: dels[i] ?? EMPTY_CELL,
          right: adds[i] ?? EMPTY_CELL,
        });
      }
      if (n > 0) runIndex += 1;
      dels = [];
      adds = [];
    };

    hunk.lines.forEach((line, li) => {
      const kind = diffLineKind(line);
      const text = stripSigil(line, kind);
      if (kind === 'del') {
        dels.push({ kind, no: oldNo, text, raw: line });
        oldNo += 1;
        return;
      }
      if (kind === 'add') {
        adds.push({ kind, no: newNo, text, raw: line });
        newNo += 1;
        return;
      }
      flush();
      if (kind === 'context') {
        rows.push({
          kind: 'pair',
          key: `h${hi}l${li}`,
          left: { kind, no: oldNo, text, raw: line },
          right: { kind, no: newNo, text, raw: line },
        });
        oldNo += 1;
        newNo += 1;
      } else {
        // `meta` belongs to neither numbering; show it on both sides so a split view
        // does not imply it applies to one file only.
        rows.push({
          kind: 'pair',
          key: `h${hi}l${li}`,
          left: { kind, no: null, text, raw: line },
          right: { kind, no: null, text, raw: line },
        });
      }
    });
    flush();
  });
  return rows;
}
