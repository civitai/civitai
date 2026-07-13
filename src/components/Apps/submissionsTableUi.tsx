import { Badge, Button, Collapse, Group, Stack, Table, Text, TextInput, UnstyledButton } from '@mantine/core';
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronRight,
  IconSearch,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import {
  ariaSortFor,
  STATUS_SECTION_ORDER,
  type AnyStatusBucket,
  type BucketedGroups,
  type SortColumn,
  type SortState,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';

/**
 * App Store Listings (W13) — shared /apps/my-submissions table UI atoms, used by
 * BOTH the onsite (`MySubmissionsList`) and offsite (`OffsiteSubmissionsList`)
 * tables so the filter box, the sortable headers, and the version-collapse toggle
 * look + behave identically. Pure presentational — all state lives in the parent
 * list; the pure filter/sort/group logic lives in `submissionsTable.ts`.
 *
 * Accessibility: the sortable header is a real <button> inside a <th> carrying
 * `aria-sort`; the version toggle is a <button> carrying `aria-expanded`.
 */

/** A sortable column header: a `<th aria-sort>` wrapping a real sort <button>. */
export function SortableTh({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortColumn;
  sort: SortState;
  onSort: (column: SortColumn) => void;
}) {
  const active = sort.column === column;
  const DirectionIcon = !active
    ? IconArrowsSort
    : sort.direction === 'asc'
    ? IconSortAscending
    : IconSortDescending;
  return (
    <Table.Th aria-sort={ariaSortFor(sort, column)}>
      <UnstyledButton
        onClick={() => onSort(column)}
        aria-label={`Sort by ${label}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Text size="sm" fw={600} span>
          {label}
        </Text>
        <DirectionIcon size={14} style={{ opacity: active ? 1 : 0.45 }} />
      </UnstyledButton>
    </Table.Th>
  );
}

/** The client-side text filter box shown above a submissions table. */
export function SubmissionSearch({
  value,
  onChange,
  testId,
  placeholder = 'Filter by app name or slug…',
}: {
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  placeholder?: string;
}) {
  return (
    <TextInput
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder={placeholder}
      aria-label="Filter submissions"
      leftSection={<IconSearch size={16} />}
      size="sm"
      maw={360}
      data-testid={testId}
    />
  );
}

/** The "N versions" expand/collapse affordance on a collapsed app group row.
 *  `variant` defaults to the filled-`light` chip (offsite list); the onsite list
 *  passes `subtle` to render it as a quiet link-styled button under the title. */
export function VersionToggle({
  expanded,
  count,
  onToggle,
  testId,
  variant = 'light',
}: {
  expanded: boolean;
  count: number;
  onToggle: () => void;
  testId?: string;
  variant?: 'light' | 'subtle' | 'transparent';
}) {
  return (
    <Button
      size="compact-xs"
      variant={variant}
      color="gray"
      aria-expanded={expanded}
      leftSection={expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
      onClick={onToggle}
      data-testid={testId}
    >
      {count} {count === 1 ? 'version' : 'versions'}
    </Button>
  );
}

/** A small inert "N versions" badge for a group with older versions (non-toggle). */
export function VersionCountBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <Badge size="xs" variant="light" color="gray">
      {count} versions
    </Badge>
  );
}

// ── status sections (UX pass) ──────────────────────────────────────────────────

/**
 * Per-section presentation: label, count-badge color, and whether the section is a
 * default-collapsed `Collapse`. Live + Pending are always-expanded (actionable);
 * Rejected + Withdrawn are terminal, so they collapse by default to keep the page
 * focused on what still needs attention.
 */
export const STATUS_SECTION_META: Record<
  AnyStatusBucket,
  { label: string; color: string; collapsible: boolean }
> = {
  live: { label: 'Live', color: 'green', collapsible: false },
  pending: { label: 'Pending', color: 'blue', collapsible: false },
  rejected: { label: 'Rejected', color: 'red', collapsible: true },
  withdrawn: { label: 'Withdrawn', color: 'gray', collapsible: true },
  // Mod-view sections (Live/Pending/Rejected reuse the entries above). `removed`
  // (the mod takedown state) stays ALWAYS-EXPANDED — a removed listing still has
  // relist/purge/claim actions a mod needs in view; `draft` is a quiet, terminal
  // default-collapsed trailing section.
  removed: { label: 'Removed', color: 'red', collapsible: false },
  draft: { label: 'Draft', color: 'gray', collapsible: true },
};

/**
 * One status section: a header (label + count badge) and its body (a table).
 * When `collapsible`, the header is a toggle button (chevron + label + count) and
 * the body is a `Collapse` that starts CLOSED — its content isn't rendered until
 * the section is opened, so a collapsed section leaves no rows in the DOM.
 */
function StatusSection({
  label,
  color,
  count,
  collapsible,
  testId,
  children,
}: {
  label: string;
  color: string;
  count: number;
  collapsible: boolean;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const countBadge = (
    <Badge size="sm" variant="light" color={color}>
      {count}
    </Badge>
  );

  if (!collapsible) {
    return (
      <Stack gap="xs" data-testid={testId}>
        <Group gap={6}>
          <Text size="sm" fw={700}>
            {label}
          </Text>
          {countBadge}
        </Group>
        {children}
      </Stack>
    );
  }

  return (
    <Stack gap="xs" data-testid={testId}>
      <UnstyledButton
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        <Text size="sm" fw={700}>
          {label}
        </Text>
        {countBadge}
      </UnstyledButton>
      <Collapse in={open}>{open ? children : null}</Collapse>
    </Stack>
  );
}

/**
 * Render a submissions list as status SECTIONS (Live → Pending → Rejected →
 * Withdrawn). Each non-empty bucket gets its own section + table (built by
 * `renderTable` from that bucket's groups); empty buckets render nothing. Shared by
 * both the onsite (`MySubmissionsList`) and offsite (`OffsiteSubmissionsList`)
 * lists so the section layout + collapse behavior are identical.
 */
export function StatusSections<T, B extends string = AnyStatusBucket>({
  buckets,
  testIdPrefix,
  renderTable,
  order = STATUS_SECTION_ORDER as unknown as readonly B[],
}: {
  buckets: BucketedGroups<T, B>;
  /** e.g. `apps-submissions-section` → section testids `${prefix}-live` etc. */
  testIdPrefix: string;
  renderTable: (groups: SubmissionGroup<T>[]) => ReactNode;
  /** Which buckets to render, in order. Defaults to the OWNER four sections; the
   *  mod table passes `MOD_STATUS_SECTION_ORDER`. */
  order?: readonly B[];
}) {
  return (
    <Stack gap="lg">
      {order.map((bucket) => {
        const groups = buckets[bucket];
        if (groups.length === 0) return null;
        const meta = STATUS_SECTION_META[bucket as AnyStatusBucket];
        return (
          <StatusSection
            key={bucket}
            label={meta.label}
            color={meta.color}
            count={groups.length}
            collapsible={meta.collapsible}
            testId={`${testIdPrefix}-${bucket}`}
          >
            {renderTable(groups)}
          </StatusSection>
        );
      })}
    </Stack>
  );
}
