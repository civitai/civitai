import { Center, Group, Loader, Paper, Text, UnstyledButton } from '@mantine/core';
import type { ReactRendererOptions } from '@tiptap/react';
import type { SuggestionProps } from '@tiptap/suggestion';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { useSuggestionListKeyboard } from '~/components/RichTextEditor/useSuggestionListKeyboard';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * One flat row in the props the suggestion plugin hands us — one per
 * (category, source) pair. The popover groups these internally so the user
 * sees one row per unique category name, with the contributing source sets
 * listed underneath. Same shape as `getMany`/`getMyUserSet` returns so
 * callers can pass results straight through.
 */
export type SnippetCategoryItem = {
  /** Category name as stored in the DB (citext). Inserted as `#id`. */
  id: string;
  /** Optional display override — defaults to `id`. */
  label?: string;
  /** Source set's display name, surfaced beneath the category in the popover. */
  setName?: string;
  /** Value count for this specific (category, source) row; summed per group. */
  valueCount?: number;
};

type Props = SuggestionProps<SnippetCategoryItem> & {
  editor: ReactRendererOptions['editor'];
  /**
   * Categories source is still being fetched. When true and no items are
   * available yet, the popover renders a loading state. If items are
   * already present (e.g. mid-refetch), the list keeps showing them.
   */
  loading?: boolean;
};

export type SnippetCategoryListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

/**
 * Aggregated view of a single category across every set that contributes
 * to it. Inserted chip is keyed only on `id` — multiple sources under one
 * category render as informational metadata, not selectable rows.
 */
type CategoryGroup = {
  /** Lower-cased lookup key (citext semantics). */
  key: string;
  /** Original casing of the first occurrence — preserved for display. */
  id: string;
  label: string;
  sources: string[];
  totalValueCount: number;
};

function groupItems(items: SnippetCategoryItem[]): CategoryGroup[] {
  const map = new Map<string, CategoryGroup>();
  for (const item of items) {
    const key = item.id.toLowerCase();
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        id: item.id,
        label: item.label ?? item.id,
        sources: [],
        totalValueCount: 0,
      };
      map.set(key, group);
    }
    if (item.setName && !group.sources.includes(item.setName)) {
      group.sources.push(item.setName);
    }
    group.totalValueCount += item.valueCount ?? 0;
  }
  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  );
}

/**
 * Popover list rendered when the user types `#`. Items arrive flat (one per
 * category-source pair); we group by lower-cased category name so each row
 * is a single category, sorted alphabetically. Source sets that contribute
 * to a category are listed as a small dimmed sub-line — same data, but
 * no longer competing visually with the category name itself.
 */
export const SnippetCategoryList = forwardRef<SnippetCategoryListRef, Props>(
  ({ items, command, query, loading }, ref) => {
    const groups = useMemo(() => groupItems(items), [items]);
    // Source names under each row only carry signal when more than one set is
    // contributing categories. With a single set, the source label is just
    // visual noise on every row — collapse to a single-line layout instead.
    const showSources = useMemo(() => {
      const distinct = new Set<string>();
      for (const item of items) {
        if (item.setName) distinct.add(item.setName);
        if (distinct.size > 1) return true;
      }
      return false;
    }, [items]);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Two-line rows (with `sourcesText`) measure ≈52px; single-line rows ≈36px.
    // The virtualizer re-measures via `measureElement` so the estimate only
    // matters for the initial window — branch by `showSources` so the
    // single-set common case overscans less aggressively.
    const virtualizer = useVirtualizer({
      count: groups.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => (showSources ? 52 : 36),
      overscan: 6,
      getItemKey: (index) => groups[index]?.key ?? index,
    });

    useEffect(() => {
      // Reset whenever the filtered group set changes so we never end up
      // with an out-of-range index after backspacing past a match.
      setSelectedIndex(0);
    }, [groups]);

    const selectItem = (index: number) => {
      const group = groups[index];
      if (!group) return;
      command({ id: group.id, label: group.label });
    };

    const scrollToIndex = useCallback(
      (index: number) => virtualizer.scrollToIndex(index, { align: 'auto' }),
      [virtualizer]
    );

    const onKeyDown = useSuggestionListKeyboard({
      length: groups.length,
      selectedIndex,
      setSelectedIndex,
      onSelect: selectItem,
      onMove: scrollToIndex,
    });

    useImperativeHandle(ref, () => ({ onKeyDown }), [onKeyDown]);

    const virtualItems = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    return (
      <Paper
        ref={scrollRef}
        className="z-50 max-h-72 overflow-y-auto"
        radius="md"
        withBorder
        shadow="md"
        miw={240}
      >
        {groups.length === 0 ? (
          <Center p="sm">
            {loading ? (
              <Group gap={6} wrap="nowrap">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Loading categories…
                </Text>
              </Group>
            ) : (
              <Text size="xs" c="dimmed">
                {query ? `No categories match "${query}"` : 'No categories loaded'}
              </Text>
            )}
          </Center>
        ) : (
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const group = groups[virtualRow.index];
              if (!group) return null;
              const isActive = virtualRow.index === selectedIndex;
              const sourcesText = showSources ? group.sources.join(' · ') : '';
              return (
                <UnstyledButton
                  key={String(virtualRow.key)}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className={clsx(
                    'flex flex-col gap-0.5 px-3 py-2 text-sm',
                    isActive && 'bg-gray-1 dark:bg-dark-5'
                  )}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onMouseEnter={() => setSelectedIndex(virtualRow.index)}
                  onClick={() => selectItem(virtualRow.index)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">#{group.label}</span>
                    {group.totalValueCount > 0 ? (
                      <Text size="xs" c="dimmed" className="shrink-0 tabular-nums">
                        {group.totalValueCount}
                      </Text>
                    ) : null}
                  </span>
                  {sourcesText ? (
                    <Text size="xs" c="dimmed" className="truncate">
                      {sourcesText}
                    </Text>
                  ) : null}
                </UnstyledButton>
              );
            })}
          </div>
        )}
      </Paper>
    );
  }
);

SnippetCategoryList.displayName = 'SnippetCategoryList';
