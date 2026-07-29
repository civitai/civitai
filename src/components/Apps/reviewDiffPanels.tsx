import { Badge, Button, Card, Code, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { IconCode, IconExternalLink } from '@tabler/icons-react';
import { useState } from 'react';

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

const SKIP_LABEL: Record<NonNullable<FileLineDiff['skipReason']>, string> = {
  binary: 'Binary file — view in Forgejo',
  'too-large': 'File too large to diff — view in Forgejo',
  'diff-too-large': 'Diff too large to display — view in Forgejo',
  'file-cap': 'Too many changed files — view this one in Forgejo',
};

export function FileDiffEntry({ file, forgejoUrl }: { file: FileLineDiff; forgejoUrl: string }) {
  const [open, setOpen] = useState(false);
  const elided = file.skipReason !== null;

  return (
    <Card withBorder p={0}>
      <Group
        justify="space-between"
        wrap="nowrap"
        p={8}
        style={{ cursor: elided ? 'default' : 'pointer' }}
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
          {!elided && (
            <Text size="xs" c="blue">
              {open ? 'hide' : 'show'}
            </Text>
          )}
        </Group>
      </Group>

      {elided && (
        <Group p={8} pt={0}>
          <Button
            component="a"
            href={forgejoUrl}
            target="_blank"
            rel="noopener"
            size="compact-xs"
            variant="subtle"
            leftSection={<IconCode size={12} />}
            rightSection={<IconExternalLink size={10} />}
          >
            View in Forgejo
          </Button>
        </Group>
      )}

      {open && !elided && (
        <ScrollArea.Autosize mah={320} style={{ background: PANEL_BG }}>
          <Stack gap={0} p={6} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
            {file.hunks.length === 0 ? (
              <Text size="xs" c="dimmed">
                No textual change (whitespace/metadata only).
              </Text>
            ) : (
              file.hunks.map((h, hi) => <DiffHunkView key={hi} hunk={h} />)
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}

export function DiffHunkView({
  hunk,
}: {
  hunk: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  };
}) {
  return (
    <>
      <Text size="xs" c="cyan" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
      </Text>
      {hunk.lines.map((line, i) => {
        const sigil = line[0];
        const color = sigil === '+' ? 'green' : sigil === '-' ? 'red' : undefined;
        // Dark-aware +/- highlight — the +9/-9 dark shades keep the add/remove
        // semantics legible against the dark panel while the light scheme keeps
        // the familiar pale green/red.
        const bg =
          sigil === '+'
            ? 'light-dark(var(--mantine-color-green-0), var(--mantine-color-green-9))'
            : sigil === '-'
            ? 'light-dark(var(--mantine-color-red-0), var(--mantine-color-red-9))'
            : undefined;
        return (
          <Text
            key={i}
            size="xs"
            c={color}
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              background: bg,
              paddingLeft: 4,
            }}
          >
            {line.length === 0 ? ' ' : line}
          </Text>
        );
      })}
    </>
  );
}

export function ManifestDiffPreview({
  diff,
}: {
  diff: { added: string[]; removed: string[]; changed: Array<{ field: string; from: unknown; to: unknown }> };
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
