import {
  Alert,
  Box,
  Divider,
  Group,
  Input,
  Loader,
  Popover,
  Stack,
  Text,
  TextInput,
  useComputedColorScheme,
} from '@mantine/core';
import { getHotkeyHandler, useClickOutside, useDebouncedValue, usePrevious } from '@mantine/hooks';
import { keepPreviousData } from '@tanstack/react-query';
import { IconPlus, IconStar, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { TagSort } from '~/server/common/enums';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import classes from './Model3DTagPicker.module.scss';

export type Model3DTagPickerValue = { id?: number; name: string };

type Props = {
  label?: string;
  description?: string;
  value: Model3DTagPickerValue[];
  onChange: (value: Model3DTagPickerValue[]) => void;
};

/**
 * Tag picker for the Model3D edit page. Mirrors the post-tag picker
 * (`EditPostTags`) but works against the in-memory edit form state
 * (parent owns the value; we only call `onChange`) rather than mutating
 * a published Post per-tag.
 *
 * Behavior:
 *   - Chips with × to remove
 *   - "+ Tag" pill opens an inline text input
 *   - Empty / short queries surface trending Model3D **category** tags
 *     (mirrors how `EditPostTags` shows category-suggestions for posts)
 *   - Typing >1 char switches to autocomplete against all Model3D-targeted
 *     tags, ranked by alphabetical name
 *   - A category tag in the dropdown gets the same little star icon the
 *     post picker uses, so users can tell curated categories apart from
 *     free-form user-generated tags
 *   - Pressing Enter on a query that doesn't match a suggestion adds a
 *     free-form tag — the Model3D upsert service handles the
 *     "create-if-missing" flow under TagTarget.Model3D
 */
export function Model3DTagPicker({ label, description, value, onChange }: Props) {
  const colorScheme = useComputedColorScheme('dark');

  const handleRemoveTag = useCallback(
    (target: Model3DTagPickerValue, index: number) => {
      const next = value.filter((tag, i) => {
        // Stored tags (with id) dedupe by id; free-form tags dedupe by
        // name + position so two pending free-form tags with the same
        // name don't collide.
        if (target.id !== undefined) return tag.id !== target.id;
        return !(tag.id === undefined && tag.name === target.name && i === index);
      });
      onChange(next);
    },
    [onChange, value]
  );

  const handleAddTag = useCallback(
    (tag: Model3DTagPickerValue) => {
      const normalized = { id: tag.id, name: tag.name.trim().toLowerCase() };
      if (!normalized.name) return;
      // Dedupe by id (if present) and by name otherwise — same rule the
      // upsert service uses on the server when it merges tagIds + tagNames.
      const exists = value.some((t) =>
        normalized.id !== undefined
          ? t.id === normalized.id || t.name === normalized.name
          : t.name === normalized.name
      );
      if (exists) return;
      onChange([...value, normalized]);
    },
    [onChange, value]
  );

  return (
    <Input.Wrapper label={label} description={description}>
      <Group gap="xs" mt={5}>
        {value.map((tag, index) => (
          <Alert
            key={tag.id ?? `${tag.name}-${index}`}
            radius="xl"
            color="gray"
            variant={colorScheme === 'dark' ? 'filled' : 'light'}
            py={4}
            pr="xs"
            style={{ minHeight: 32, display: 'flex', alignItems: 'center' }}
          >
            <Group gap="xs">
              <Text>{tag.name}</Text>
              <LegacyActionIcon
                size="xs"
                variant="outline"
                radius="xl"
                onClick={() => handleRemoveTag(tag, index)}
                aria-label={`Remove tag ${tag.name}`}
              >
                <IconX size={14} />
              </LegacyActionIcon>
            </Group>
          </Alert>
        ))}
        <TagPicker onAdd={handleAddTag} selected={value} />
      </Group>
    </Input.Wrapper>
  );
}

function TagPicker({
  onAdd,
  selected,
}: {
  onAdd: (tag: Model3DTagPickerValue) => void;
  selected: Model3DTagPickerValue[];
}) {
  const colorScheme = useComputedColorScheme('dark');
  const browsingLevel = useBrowsingLevelDebounced();

  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 250);
  const [active, setActive] = useState<number | undefined>();
  const [dropdown, setDropdown] = useState<HTMLDivElement | null>(null);
  const [control, setControl] = useState<HTMLInputElement | null>(null);

  // Trending = mod-curated category tags. Once the user types 2+ chars,
  // switch to a general autocomplete that matches against *any*
  // Model3D-targeted tag.
  const useTrending = debouncedQuery.length < 2;
  const { data, isFetching } = trpc.tag.getAll.useQuery(
    {
      entityType: [TagTarget.Model3D],
      query: useTrending ? undefined : debouncedQuery.toLowerCase(),
      categories: useTrending ? true : undefined,
      sort: TagSort.MostModels, // ignored if not in the sort union — falls back to name ASC
      include: ['isCategory', 'nsfwLevel'],
      nsfwLevel: browsingLevel,
      limit: 25,
    },
    { placeholderData: keepPreviousData }
  );

  const filteredData = useMemo(() => {
    const selectedNames = new Set(selected.map((t) => t.name.toLowerCase()));
    return (data?.items ?? []).filter((x) => !selectedNames.has(x.name.toLowerCase()));
  }, [data, selected]);

  const previousData = usePrevious(filteredData.length);
  useEffect(() => {
    if (previousData !== filteredData.length) setActive(undefined);
  }, [filteredData.length, previousData]);

  const handleClose = useCallback(() => {
    setEditing(false);
    setQuery('');
    setActive(undefined);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = query.trim();
    // Priority order:
    //   1. Arrow-key-highlighted suggestion in the dropdown
    //   2. Exact-name match against a suggestion (so a typed "fantasy"
    //      that exactly matches a server suggestion attaches the existing
    //      tag id instead of round-tripping a fresh "fantasy" through the
    //      upsert's create-if-missing path)
    //   3. A non-empty free-form query → create-on-save
    // Without (3) the previous version silently dropped Enter whenever
    // there were suggestions but the user hadn't arrow-navigated yet,
    // which made the picker feel broken for the most common path:
    // "type and hit Enter".
    if (filteredData.length && active !== undefined) {
      const tag = filteredData[active];
      onAdd({ id: tag.id, name: tag.name });
    } else if (trimmed.length) {
      const exact = filteredData.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
      if (exact) onAdd({ id: exact.id, name: exact.name });
      else onAdd({ name: trimmed });
    }
    handleClose();
  }, [active, filteredData, handleClose, onAdd, query]);

  const handleUp = useCallback(() => {
    if (!filteredData.length) return;
    setActive((cur) => {
      if (cur === undefined) return 0;
      return Math.max(0, cur - 1);
    });
  }, [filteredData.length]);

  const handleDown = useCallback(() => {
    if (!filteredData.length) return;
    setActive((cur) => {
      if (cur === undefined) return 0;
      return Math.min(filteredData.length - 1, cur + 1);
    });
  }, [filteredData.length]);

  useClickOutside(handleClose, null, [control, dropdown]);

  const target = (
    <Alert
      radius="xl"
      py={4}
      color="gray"
      variant={colorScheme === 'dark' ? 'filled' : 'light'}
      onClick={() => setEditing(true)}
      style={{ minHeight: 32, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
    >
      {!editing ? (
        <Group gap={4}>
          <IconPlus size={16} />
          <Text>Tag</Text>
        </Group>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <TextInput
            ref={setControl}
            variant="unstyled"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a tag…"
            styles={{
              input: {
                fontSize: 16,
                padding: 0,
                lineHeight: 1,
                height: 'auto',
                minHeight: 0,
                minWidth: 100,
                width: !query.length ? '8ch' : `${Math.max(query.length, 8)}ch`,
              },
            }}
            onKeyDown={getHotkeyHandler([
              ['Enter', handleSubmit],
              ['ArrowUp', handleUp],
              ['ArrowDown', handleDown],
              ['Escape', handleClose],
            ])}
            autoFocus
          />
        </form>
      )}
    </Alert>
  );

  const label = useTrending ? 'Curated categories' : 'Matching tags';
  const trimmedQuery = query.trim();
  const showEmptyState = !isFetching && filteredData.length === 0;

  return (
    // Open the popover the moment the user starts editing — the dropdown
    // doubles as the "we're fetching tags" indicator. Closing it on
    // `filteredData.length > 0` (the original gate) made the picker look
    // dead on first focus, since the trending fetch hasn't resolved yet
    // and an empty category list (no mod has linked tags to the
    // `model3d category` system tag yet) returns zero results forever.
    <Popover opened={editing} position="bottom-start" shadow="lg">
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown p={0}>
        <Box style={{ width: 300 }} ref={setDropdown}>
          <Group justify="space-between" px="sm" py="xs">
            <Text fw={500}>{label}</Text>
            {isFetching && <Loader type="dots" size="xs" />}
          </Group>
          <Divider />
          {showEmptyState ? (
            <Stack gap={4} px="sm" py="md" align="center" ta="center">
              <Text size="sm" c="dimmed">
                {trimmedQuery.length
                  ? `No tags match “${trimmedQuery}”.`
                  : 'No trending tags yet.'}
              </Text>
              {trimmedQuery.length > 0 && (
                <Text size="xs" c="dimmed">
                  Press <strong>Enter</strong> to create &ldquo;{trimmedQuery}&rdquo;.
                </Text>
              )}
            </Stack>
          ) : null}
          <Stack gap={0}>
            {filteredData.map((tag, index) => (
              <Group
                key={tag.id}
                justify="space-between"
                className={clsx(classes.row, { [classes.active]: index === active })}
                onMouseOver={() => setActive(index)}
                onMouseLeave={() => setActive(undefined)}
                onClick={() => {
                  onAdd({ id: tag.id, name: tag.name });
                  handleClose();
                }}
                p="sm"
              >
                <Group gap={4}>
                  <Text size="sm">{tag.name}</Text>
                  {tag.isCategory && (
                    <IconStar size={12} className={classes.categoryIcon} />
                  )}
                </Group>
              </Group>
            ))}
          </Stack>
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}
