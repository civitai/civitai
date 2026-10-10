import { Badge, Card, Code, Group, ScrollArea, SegmentedControl, Stack, Text } from '@mantine/core';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import {
  splitDiffRows,
  unifiedDiffRows,
  type DiffSplitCell,
  type DiffSplitRow,
  type DiffLineKind,
  type DiffUnifiedRow,
} from '~/components/Apps/reviewDiffRows';

/**
 * Diff-preview panels for the /apps/review moderator queue (on-site version
 * review). Extracted from `~/pages/apps/review` — the page pulls in the full
 * tRPC server graph via `createServerSideProps`, so keeping these pure,
 * server-free presentational components in their own module lets them be unit
 * tested in browser mode without booting the server.
 *
 * Theme note: all panel/line backgrounds use `light-dark(...)` so they remap for
 * the dark color scheme instead of rendering a fixed light `gray-0`/`green-0`/
 * `red-0` shade (the "white diff box in dark mode" bug). Precedent:
 * `~/pages/moderator/scanner-policies` `bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"`.
 */

// Shared panel background — light gray in the light scheme, a dark surface in
// the dark scheme (single source of truth for the three diff panels).
const PANEL_BG = 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))';

/**
 * The per-file STICKY HEADER's surface.
 *
 * 🔴 `gray-1`/`dark-5`, ONE STEP OFF {@link PANEL_BG} ON PURPOSE. The header has to read
 * as a different plane from the code it floats over, in BOTH schemes — with the same
 * token on both it vanishes the moment a line scrolls under it, which is the one thing a
 * sticky header must never do.
 */
const FILE_HEADER_BG = 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))';

/**
 * The geometry BOTH diff tables must share.
 *
 * 🔴 THE TRIO IS ONE DECISION, NOT THREE PROPERTIES. `width: max-content` + `minWidth: 100%`
 * is what makes a long line overflow its own box so the code area's `overflow-x: auto` has
 * something to scroll, while a short file still fills the panel; `borderCollapse` keeps the
 * gutter flush against the code. Change one of the three on one table only and that layout
 * stops scrolling inside the box — the page body scrolls sideways instead, which is the one
 * thing the brief says must never happen. Pinned for the unified table by the
 * horizontal-scroll case in `src/components/Apps/reviewDiffViewer.browser.test.tsx`.
 */
// 🔴 ANNOTATED, NOT A BARE `as const`. Measured: under `as const` a typo'd key
// (`bordrCollapse`) typechecks CLEAN — the object reaches `style=` as a variable, so there is
// no excess-property check, and `as const` constrains the VALUES rather than the key set. The
// annotation catches it (TS2561). `as const satisfies` would ALSO make the object deeply
// readonly, which was tried and reverted: nothing assigns through either style object here,
// and the bare annotation is this repo's form — `MONO` below, and 23 sites across 17 files.
const DIFF_TABLE_STYLE: CSSProperties = {
  borderCollapse: 'collapse',
  width: 'max-content',
  minWidth: '100%',
};

/** Line-number gutter surface — fainter than the header, still distinct from the code. */
const GUTTER_BG = 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))';

/**
 * Per-line backgrounds for an add / delete.
 *
 * 🔴 EVERY ONE IS `light-dark(...)`, AND THAT IS A FIXED BUG, NOT A STYLE CHOICE. A fixed
 * `green-0`/`red-0`/`gray-0` here is the "white diff box in dark mode" defect this module
 * was already corrected for once — see the module docstring. The `+9`/`-9` dark shades keep
 * the add/remove semantics legible against the dark panel while the light scheme keeps the
 * familiar pale green/red.
 */
const LINE_BG: Record<DiffLineKind | 'empty', string | undefined> = {
  add: 'light-dark(var(--mantine-color-green-0), var(--mantine-color-green-9))',
  del: 'light-dark(var(--mantine-color-red-0), var(--mantine-color-red-9))',
  context: undefined,
  meta: undefined,
  // 🔴 THE SAME SURFACE AS THE GUTTER, SO THE SAME TOKEN. A split row's filler cell and the
  // line-number gutter are one decision — "the inactive surface" — and spelling it twice
  // means retuning the gutter silently leaves the filler behind.
  empty: GUTTER_BG,
};

/** Mantine colour name for a line's text, or undefined to inherit. */
const LINE_FG: Record<DiffLineKind | 'empty', string | undefined> = {
  add: 'green',
  del: 'red',
  context: undefined,
  meta: 'dimmed',
  empty: undefined,
};

/**
 * How tall a single file's diff box may grow before it scrolls internally.
 *
 * 🔴 THE SCROLL IS INSIDE THE FILE BOX, BOTH AXES, and that is what keeps the PAGE from
 * ever scrolling horizontally. A long line scrolls the code area, not the document; a long
 * file scrolls the box, not the document. Nothing here may set `overflow: visible`.
 */
const FILE_MAX_HEIGHT = 420;

/** The monospace cell style shared by every diff line + gutter. */
const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  lineHeight: '18px',
};

export function FileListPreview({
  added,
  removed,
  changed,
}: {
  added?: string[];
  removed?: string[];
  changed?: string[];
}) {
  const lines: Array<{ sigil: '+' | '~' | '-'; path: string; color: string }> = [];
  for (const p of added ?? []) lines.push({ sigil: '+', path: p, color: 'green' });
  for (const p of changed ?? []) lines.push({ sigil: '~', path: p, color: 'yellow' });
  for (const p of removed ?? []) lines.push({ sigil: '-', path: p, color: 'red' });
  if (lines.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No file-level changes.
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={180} style={{ background: PANEL_BG }}>
      <Stack gap={2} p={6}>
        {lines.map((l) => (
          <Group key={`${l.sigil}-${l.path}`} gap={6} wrap="nowrap">
            <Text size="xs" c={l.color} fw={700} style={{ width: 12 }}>
              {l.sigil}
            </Text>
            <Code style={{ fontSize: 11 }}>{l.path}</Code>
          </Group>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

export type FileLineDiff = {
  path: string;
  changeKind: 'added' | 'changed';
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  skipReason: 'binary' | 'too-large' | 'diff-too-large' | 'file-cap' | null;
  added: number;
  removed: number;
};

/**
 * Why a file has no inline diff. These used to end in "— view in Forgejo" next
 * to a deep-link into the raw in-review snapshot; that link was retired in
 * #3498 when snapshots became private (an anonymous click 404s, and a dead link
 * is worse than none). The labels now just state the reason — the mod knows the
 * file changed and why it isn't rendered, which is what the label is for.
 */
export const SKIP_LABEL: Record<NonNullable<FileLineDiff['skipReason']>, string> = {
  binary: 'Binary file — no inline diff',
  'too-large': 'File too large to diff',
  'diff-too-large': 'Diff too large to display',
  'file-cap': 'Too many changed files — this one not diffed',
};

/** Which layout a file's diff is rendered in. Per-file, not per-page. */
export type DiffLayout = 'unified' | 'split';

/**
 * ONE file's diff, rendered in the GitHub shape: a STICKY header carrying the path and
 * `+N −M`, old/new line-number gutters, monospace code, `@@` hunk separators, and a
 * unified/split toggle.
 *
 * 🔴 ONE IMPLEMENTATION, BOTH SURFACES. This renders in the queue MODAL (via
 * `OnsiteReviewModalBody`'s code-diff panel, and again inside `CombinedReviewModal`) and
 * in the review PAGE's Code tab. The page redesign rearranges WHICH PANELS GO WHERE; it
 * deliberately does not fork the panels themselves, because a second per-file diff
 * renderer is the thing that would drift — and the shared body's docstring asks the two
 * surfaces not to FORK a panel. It does not ask them to behave identically: the review page
 * memoises its tab subtree while the modal re-renders per minute, which is a documented
 * difference, not a drift.
 *
 * 🔴 THE `skipReason` LABELS ARE UNCHANGED AND CARRY NO LINK. `SKIP_LABEL`'s docstring
 * records why: the "— view in Forgejo" deep-links were retired in #3498 because in-review
 * snapshots are private, so an anonymous click 404s and a dead link is worse than none. Do
 * not re-add an external deep-link here.
 *
 * Collapsed by default, so the panel's laziness is unchanged: the page's Code tab only
 * fetches the diff when the mod opens the tab, and a file's rows are only built when the
 * mod opens the file.
 */
export function FileDiffEntry({
  file,
  defaultLayout = 'unified',
}: {
  file: FileLineDiff;
  /** Starting layout. `unified` is the default — split is opt-in, per file. */
  defaultLayout?: DiffLayout;
}) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<DiffLayout>(defaultLayout);
  const elided = file.skipReason !== null;

  // Rows are derived only once the file is OPEN, so a 300-file diff costs nothing until a
  // mod expands something.
  const unified = useMemo(
    () => (open && !elided && layout === 'unified' ? unifiedDiffRows(file.hunks) : []),
    [open, elided, layout, file.hunks]
  );
  const split = useMemo(
    () => (open && !elided && layout === 'split' ? splitDiffRows(file.hunks) : []),
    [open, elided, layout, file.hunks]
  );

  return (
    <Card withBorder p={0} data-testid="apps-review-file-diff" data-path={file.path}>
      {/*
        🔴 THE VERTICAL SCROLLER AND THE HORIZONTAL ONE ARE DIFFERENT BOXES, and the split
        is what makes the header actually stick. `position: sticky` pins against the
        nearest scrolling ancestor on the axis it is given; put the header inside a box
        that scrolls BOTH ways and it slides out of view horizontally the moment a long
        line is panned. So: this box scrolls Y (and the header sticks to its top), and the
        code area inside scrolls X on its own.
      */}
      <div style={{ maxHeight: open && !elided ? FILE_MAX_HEIGHT : undefined, overflowY: 'auto' }}>
        <Group
          justify="space-between"
          wrap="nowrap"
          p={8}
          data-testid="apps-review-diff-file-header"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: FILE_HEADER_BG,
            cursor: elided ? 'default' : 'pointer',
          }}
          onClick={() => {
            if (!elided) setOpen((v) => !v);
          }}
        >
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <Badge
              size="xs"
              color={file.changeKind === 'added' ? 'green' : 'yellow'}
              variant="light"
            >
              {file.changeKind === 'added' ? 'added' : 'changed'}
            </Badge>
            <Code style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {file.path}
            </Code>
          </Group>
          <Group gap={6} wrap="nowrap">
            {!elided && file.added > 0 && (
              <Text size="xs" c="green" fw={700}>
                +{file.added}
              </Text>
            )}
            {!elided && file.removed > 0 && (
              <Text size="xs" c="red" fw={700}>
                −{file.removed}
              </Text>
            )}
            {elided && (
              <Text size="xs" c="dimmed" fs="italic">
                {SKIP_LABEL[file.skipReason!]}
              </Text>
            )}
            {open && !elided && (
              // 🔴 `stopPropagation`, because the whole header toggles the file open. Without
              // it switching layout also collapses the file you were reading.
              <span
                onClick={(e: React.MouseEvent<HTMLSpanElement>) => e.stopPropagation()}
                data-testid="apps-review-diff-layout"
              >
                <SegmentedControl
                  size="xs"
                  value={layout}
                  onChange={(v) => setLayout(v as DiffLayout)}
                  data={[
                    { value: 'unified', label: 'Unified' },
                    { value: 'split', label: 'Split' },
                  ]}
                  aria-label={`Diff layout for ${file.path}`}
                />
              </span>
            )}
            {!elided && (
              <Text size="xs" c="blue">
                {open ? 'hide' : 'show'}
              </Text>
            )}
          </Group>
        </Group>

        {open && !elided && (
          <div style={{ background: PANEL_BG, overflowX: 'auto' }}>
            {file.hunks.length === 0 ? (
              <Text size="xs" c="dimmed" p={6}>
                No textual change (whitespace/metadata only).
              </Text>
            ) : layout === 'unified' ? (
              <UnifiedRowsTable rows={unified} />
            ) : (
              <SplitRowsTable rows={split} />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** One line-number gutter cell. `null` renders an empty gutter, never a `0`. */
function LineNumberCell({ value }: { value: number | null }) {
  return (
    <td
      style={{
        ...MONO,
        background: GUTTER_BG,
        color: 'var(--mantine-color-dimmed)',
        textAlign: 'right',
        padding: '0 6px',
        // 🔴 The gutters must not be squeezed out by a long code line, and they must not
        // be selectable — a copy of a diff that carries line numbers is unusable.
        minWidth: 34,
        width: 34,
        userSelect: 'none',
        verticalAlign: 'top',
        whiteSpace: 'nowrap',
      }}
    >
      {value ?? ''}
    </td>
  );
}

/**
 * One unified code cell.
 *
 * 🔴 `white-space: pre`, NOT `pre-wrap`. Wrapping a diff line re-flows the code against
 * its own line numbers, so a long line silently misaligns every row below it in a split
 * view and makes the gutter meaningless in a unified one. The line overflows and the code
 * area scrolls — which is why the X-scroller above exists.
 */
function CodeCell({ kind, raw }: { kind: DiffLineKind; raw: string }) {
  return (
    <td
      style={{
        ...MONO,
        background: LINE_BG[kind],
        padding: '0 8px',
        verticalAlign: 'top',
        whiteSpace: 'pre',
        width: '100%',
      }}
    >
      <Text span size="xs" c={LINE_FG[kind]} style={MONO}>
        {raw.length === 0 ? ' ' : raw}
      </Text>
    </td>
  );
}

/**
 * One side of a split row — an `empty` filler cell paints the gap, with no text.
 *
 * 🔴 `white-space: pre` FOR THE SAME REASON AS {@link CodeCell}, and it matters MORE here:
 * a wrapped line in one column desynchronises that column from the other for every row
 * below it, so the two sides stop describing the same lines. The declaration is repeated
 * rather than shared because the two cells differ in `width` (`100%` vs `50%`) and in
 * whether they can be empty; what must not happen is one of them quietly becoming
 * `pre-wrap`. Pinned on the unified side by the horizontal-scroll test in
 * `src/components/Apps/reviewDiffViewer.browser.test.tsx`.
 */
function SplitCodeCell({ cell }: { cell: DiffSplitCell }) {
  return (
    <td
      style={{
        ...MONO,
        background: LINE_BG[cell.kind],
        padding: '0 8px',
        verticalAlign: 'top',
        whiteSpace: 'pre',
        width: '50%',
      }}
    >
      {cell.kind === 'empty' ? (
        ''
      ) : (
        <Text span size="xs" c={LINE_FG[cell.kind]} style={MONO}>
          {cell.raw.length === 0 ? ' ' : cell.raw}
        </Text>
      )}
    </td>
  );
}

/**
 * The UNIFIED rows as a table — hunk headers, both gutters, the code column.
 *
 * 🔴 ONE RENDERER, NOT TWO, and the precise history because an earlier draft of this note
 * got it wrong. On `origin/main` `FileDiffEntry` RENDERED the exported `DiffHunkView` — it
 * was its child, not a rival copy — and the only consumer from outside this module was the
 * dark-theme guard. Rewriting `FileDiffEntry`'s body around this table left `DiffHunkView`
 * with no production caller at all, so that guard became a test of a renderer no moderator
 * would ever see while the structure they DO see was free to change underneath it. The
 * export is deleted and the guard now renders `FileDiffEntry`. (The earlier wording said it
 * had "ZERO production callers" without the "after the rewrite", which reads as a claim
 * about the base and is false there.)
 */
function UnifiedRowsTable({ rows }: { rows: DiffUnifiedRow[] }) {
  return (
    <table style={DIFF_TABLE_STYLE} data-testid="apps-review-diff-unified">
      <tbody>
        {rows.map((row) =>
          row.kind === 'hunk' ? (
            <tr key={row.key}>
              <td colSpan={3} style={{ ...MONO, padding: '2px 6px' }}>
                <Text span size="xs" c="cyan" style={MONO}>
                  {row.label}
                </Text>
              </td>
            </tr>
          ) : (
            <tr key={row.key} data-line-kind={row.kind}>
              <LineNumberCell value={row.oldNo} />
              <LineNumberCell value={row.newNo} />
              <CodeCell kind={row.kind} raw={row.raw} />
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

/**
 * The SPLIT rows as a table — hunk headers, then old-gutter / old-code / new-gutter /
 * new-code.
 *
 * 🔴 EXTRACTED FOR SYMMETRY WITH {@link UnifiedRowsTable}, which is not cosmetic: a change
 * to one layout that misses the other is invisible until someone switches the toggle. The
 * geometry the two must share is now {@link DIFF_TABLE_STYLE} rather than a note asking
 * them to agree — a docstring cannot make disagreement impossible, and this file already
 * takes that move everywhere else (`MONO`, `GUTTER_BG`, `LINE_BG.empty = GUTTER_BG`).
 */
function SplitRowsTable({ rows }: { rows: DiffSplitRow[] }) {
  return (
    <table style={DIFF_TABLE_STYLE} data-testid="apps-review-diff-split">
      <tbody>
        {rows.map((row) =>
          row.kind === 'hunk' ? (
            <tr key={row.key}>
              <td colSpan={4} style={{ ...MONO, padding: '2px 6px' }}>
                <Text span size="xs" c="cyan" style={MONO}>
                  {row.label}
                </Text>
              </td>
            </tr>
          ) : (
            <tr key={row.key}>
              <LineNumberCell value={row.left.no} />
              <SplitCodeCell cell={row.left} />
              <LineNumberCell value={row.right.no} />
              <SplitCodeCell cell={row.right} />
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

export function ManifestDiffPreview({
  diff,
}: {
  diff: {
    added: string[];
    removed: string[];
    changed: Array<{ field: string; from: unknown; to: unknown }>;
  };
}) {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No manifest changes (bundle resubmit with code-only diff).
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={260} style={{ background: PANEL_BG }}>
      <Stack gap={6} p={8}>
        {diff.added.map((field) => (
          <Group key={`+${field}`} gap={6}>
            <Text size="xs" c="green" fw={700}>
              +
            </Text>
            <Code style={{ fontSize: 11 }}>{field}</Code>
            <Text size="xs" c="dimmed">
              added
            </Text>
          </Group>
        ))}
        {diff.removed.map((field) => (
          <Group key={`-${field}`} gap={6}>
            <Text size="xs" c="red" fw={700}>
              −
            </Text>
            <Code style={{ fontSize: 11 }}>{field}</Code>
            <Text size="xs" c="dimmed">
              removed
            </Text>
          </Group>
        ))}
        {diff.changed.map((change) => (
          <Stack key={`~${change.field}`} gap={2}>
            <Group gap={6}>
              <Text size="xs" c="yellow" fw={700}>
                ~
              </Text>
              <Code style={{ fontSize: 11 }}>{change.field}</Code>
              <Text size="xs" c="dimmed">
                changed
              </Text>
            </Group>
            <Group gap={8} pl={18} align="flex-start">
              <Text size="xs" c="dimmed" style={{ minWidth: 32 }}>
                from
              </Text>
              <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(change.from)}
              </Code>
            </Group>
            <Group gap={8} pl={18} align="flex-start">
              <Text size="xs" c="dimmed" style={{ minWidth: 32 }}>
                to
              </Text>
              <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(change.to)}
              </Code>
            </Group>
          </Stack>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}
