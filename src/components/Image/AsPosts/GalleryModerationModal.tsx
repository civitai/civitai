import {
  ActionIcon,
  Autocomplete,
  Badge,
  Card,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { IconCheck, IconSearch, IconX } from '@tabler/icons-react';
import React, { useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { useGallerySettings } from './gallery.utils';
import {
  allBrowsingLevelsFlag,
  browsingLevelDescriptions,
  browsingLevelLabels,
  browsingLevels,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { createDebouncer } from '~/utils/debouncer';
import { TagSort } from '~/server/common/enums';

export function GalleryModerationModal({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} title="Gallery Moderation Preferences">
      <Stack>
        <HiddenTagsSection modelId={modelId} />
        <HiddenUsersSection modelId={modelId} />
        <MatureContentSection modelId={modelId} />
      </Stack>
    </Modal>
  );
}

export function HiddenTagsSection({ modelId }: { modelId: number }) {
  const { gallerySettings, toggle } = useGallerySettings({ modelId: modelId });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data, isLoading } = trpc.tag.getAll.useQuery({
    query: debouncedSearch.toLowerCase().trim(),
    excludedTagIds: gallerySettings?.hiddenTags.map((x) => x.id),
    sort: TagSort.MostHidden,
  });
  const options =
    data?.items
      .filter((x) => !gallerySettings?.hiddenTags.some((y) => y.id === x.id))
      .map(({ id, name }) => ({ id, value: name })) ?? [];

  const hiddenTags = gallerySettings?.hiddenTags ?? [];

  const handleToggleBlockedTag = async (tag: { id: number; name: string }) => {
    await toggle({ modelId: modelId, tags: [tag] }).catch(() => null);
    setSearch('');
  };

  return (
    <Card withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Tags</Text>
      </Card.Section>
      <Card.Section withBorder sx={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search tags to hide"
          data={options}
          value={search}
          onChange={setSearch}
          icon={isLoading ? <Loader size="xs" /> : <IconSearch size={14} />}
          onItemSubmit={(item: { value: string; id: number }) => {
            handleToggleBlockedTag({ id: item.id, name: item.value });
            searchInputRef.current?.focus();
          }}
          withinPortal
          variant="unstyled"
        />
      </Card.Section>
      <Card.Section inheritPadding pt="md" pb="xs">
        <Stack spacing={5}>
          {hiddenTags.length > 0 && (
            <Group spacing={4}>
              {hiddenTags.map((tag) => (
                <Badge
                  key={tag.id}
                  sx={{ paddingRight: 3 }}
                  rightSection={
                    <ActionIcon
                      size="xs"
                      color="blue"
                      radius="xl"
                      variant="transparent"
                      onClick={() => handleToggleBlockedTag(tag)}
                    >
                      <IconX size={10} />
                    </ActionIcon>
                  }
                >
                  {tag.name}
                </Badge>
              ))}
            </Group>
          )}
          <Text color="dimmed" size="xs">
            Content with these tags will not show up in your resource gallery page.
          </Text>
        </Stack>
      </Card.Section>
    </Card>
  );
}

export function HiddenUsersSection({ modelId }: { modelId: number }) {
  const { gallerySettings, toggle } = useGallerySettings({ modelId: modelId });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: debouncedSearch !== '' }
  );
  const options =
    data?.filter((x) => x.username).map(({ id, username }) => ({ id, value: username ?? '' })) ??
    [];

  const handleToggleBlocked = async (user: { id: number; username: string | null }) => {
    await toggle({ modelId: modelId, users: [user] }).catch(() => null);
    setSearch('');
  };

  return (
    <Card withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Users</Text>
      </Card.Section>
      <Card.Section withBorder sx={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search users to hide"
          data={options}
          value={search}
          onChange={setSearch}
          icon={isLoading && isFetching ? <Loader size="xs" /> : <IconSearch size={14} />}
          onItemSubmit={({ id, value: username }: { value: string; id: number }) => {
            handleToggleBlocked({ id, username });
            searchInputRef.current?.focus();
          }}
          withinPortal
          variant="unstyled"
        />
      </Card.Section>
      <Card.Section inheritPadding pt="md" pb="xs">
        <Stack spacing={5}>
          {gallerySettings && gallerySettings.hiddenUsers.length > 0 && (
            <Group spacing={4}>
              {gallerySettings.hiddenUsers.map((user) => (
                <Badge
                  key={user.id}
                  sx={{ paddingRight: 3 }}
                  rightSection={
                    <ActionIcon
                      size="xs"
                      color="blue"
                      radius="xl"
                      variant="transparent"
                      onClick={() => handleToggleBlocked(user)}
                    >
                      <IconX size={10} />
                    </ActionIcon>
                  }
                >
                  {user.username}
                </Badge>
              ))}
            </Group>
          )}
          <Text color="dimmed" size="xs">
            Content from these users will not show up in your resource gallery page.
          </Text>
        </Stack>
      </Card.Section>
    </Card>
  );
}

function MatureContentSection({ modelId }: { modelId: number }) {
  const { gallerySettings } = useGallerySettings({ modelId });
  if (!gallerySettings) return null;
  return <BrowsingLevelsStacked level={gallerySettings.level} modelId={modelId} />;
}

const debouncer = createDebouncer(1000);
function BrowsingLevelsStacked({
  level = allBrowsingLevelsFlag,
  modelId,
}: {
  level?: number;
  modelId: number;
}) {
  const { classes, cx } = useStyles();
  const { toggle } = useGallerySettings({ modelId: modelId });
  const [browsingLevel, setBrowsingLevel] = useState(level);
  const toggleBrowsingLevel = (level: number) => {
    setBrowsingLevel((state) => {
      return Flags.hasFlag(state, level)
        ? Flags.removeFlag(state, level)
        : Flags.addFlag(state, level);
    });
  };

  useDidUpdate(() => {
    debouncer(() => toggle({ modelId, level: browsingLevel }));
  }, [browsingLevel]);

  return (
    <div>
      <Text weight={500}>Allowed Browsing Levels</Text>
      <Paper withBorder p={0} className={classes.root}>
        {browsingLevels.map((level) => {
          const isSelected = Flags.hasFlag(browsingLevel, level);
          return (
            <Group
              position="apart"
              key={level}
              p="md"
              onClick={() => toggleBrowsingLevel(level)}
              className={cx({ [classes.active]: isSelected })}
              noWrap
            >
              <Group noWrap>
                <Text weight={700} w={50} ta="center">
                  {browsingLevelLabels[level]}
                </Text>
                <Text lh={1.2} size="sm" ta="left" sx={{ flex: '1 1' }}>
                  {browsingLevelDescriptions[level]}
                </Text>
              </Group>
              <Text color="green" inline style={{ visibility: !isSelected ? 'hidden' : undefined }}>
                <IconCheck />
              </Text>
            </Group>
          );
        })}
      </Paper>
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    ['& > div']: {
      ['&:hover']: {
        background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
        cursor: 'pointer',
      },
      ['&:not(:last-child)']: {
        borderBottom: `1px ${
          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
        } solid`,
      },
    },
  },
  active: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
  },
}));
