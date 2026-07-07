import { Badge, Button, Table, Text, TextInput, UnstyledButton } from '@mantine/core';
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronRight,
  IconSearch,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { ariaSortFor, type SortColumn, type SortState } from '~/components/Apps/submissionsTable';

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

/** The "N versions" expand/collapse affordance on a collapsed app group row. */
export function VersionToggle({
  expanded,
  count,
  onToggle,
  testId,
}: {
  expanded: boolean;
  count: number;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <Button
      size="compact-xs"
      variant="light"
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
