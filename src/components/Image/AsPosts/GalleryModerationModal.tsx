import {
  Autocomplete,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconSearch, IconX } from '@tabler/icons-react';
import React, { useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { useGallerySettings } from './gallery.utils';
import {
  allBrowsingLevelsFlag,
  browsingLevelDescriptions,
  browsingLevelLabels,
  browsingLevels,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { createDebouncer } from '~/utils/debouncer';
import { TagSort } from '~/server/common/enums';
import { openConfirmModal } from '@mantine/modals';
import classes from './GalleryModerationModal.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function GalleryModerationModal({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const { copySettings, updating, copySettingsLoading } = useGallerySettings({ modelId: modelId });

  const handleCopySettings = () => {
    openConfirmModal({
      title: (
        <div className="flex flex-row flex-nowrap gap-2">
          <IconAlertTriangle color="gold" />
          <p className="text-lg">Copy Gallery Moderation Preferences</p>
        </div>
      ),
      centered: true,
      children:
        'This will copy the gallery moderation preferences from this model to all your models and future ones. Are you sure you want to proceed?',
      onConfirm: async () => {
        try {
          await copySettings(modelId);
          dialog.onClose();
        } catch {
          // Error is handled in the hook
        }
      },
      labels: { confirm: 'Yes, continue', cancel: 'No, cancel' },
    });
  };

  return (
    <Modal {...dialog} title="Gallery Moderation Preferences">
      <Stack>
        <HiddenTagsSection modelId={modelId} />
        <HiddenUsersSection modelId={modelId} />
        <MatureContentSection modelId={modelId} />

        <Button
          variant="outline"
          size="xs"
          onClick={handleCopySettings}
          loading={updating || copySettingsLoading}
        >
          Apply these settings to all my models
        </Button>
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
        <Text fw={500}>Hidden Tags</Text>
      </Card.Section>
      <Card.Section withBorder style={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search tags to hide"
          data={options}
          value={search}
          onChange={setSearch}
          leftSection={isLoading ? <Loader size="xs" /> : <IconSearch size={14} />}
          onOptionSubmit={(value: string) => {
            const item = options.find((o) => o.value === value);
            if (!item) return;
            handleToggleBlockedTag({ id: item.id, name: item.value });
            searchInputRef.current?.focus();
          }}
          variant="unstyled"
        />
      </Card.Section>
      <Card.Section inheritPadding pt="md" pb="xs">
        <Stack gap={5}>
          {hiddenTags.length > 0 && (
            <Group gap={4}>
              {hiddenTags.map((tag) => (
                <Badge
                  key={tag.id}
                  style={{ paddingRight: 3 }}
                  rightSection={
                    <LegacyActionIcon
                      size="xs"
                      color="blue"
                      radius="xl"
                      variant="transparent"
                      onClick={() => handleToggleBlockedTag(tag)}
                    >
                      <IconX size={10} />
                    </LegacyActionIcon>
                  }
                >
                  {tag.name}
                </Badge>
              ))}
            </Group>
          )}
          <Text c="dimmed" size="xs">
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
        <Text fw={500}>Hidden Users</Text>
      </Card.Section>
      <Card.Section withBorder style={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search users to hide"
          data={options}
          value={search}
          onChange={setSearch}
          leftSection={isLoading && isFetching ? <Loader size="xs" /> : <IconSearch size={14} />}
          onOptionSubmit={(value: string) => {
            const { id } = options.find((x) => x.value === value) ?? {};
            if (!id) return;
            handleToggleBlocked({ id, username: value });
            searchInputRef.current?.focus();
          }}
        />
      </Card.Section>
      <Card.Section inheritPadding pt="md" pb="xs">
        <Stack gap={5}>
          {gallerySettings && gallerySettings.hiddenUsers.length > 0 && (
            <Group gap={4}>
              {gallerySettings.hiddenUsers.map((user) => (
                <Badge
                  key={user.id}
                  style={{ paddingRight: 3 }}
                  rightSection={
                    <LegacyActionIcon
                      size="xs"
                      color="blue"
                      radius="xl"
                      variant="transparent"
                      onClick={() => handleToggleBlocked(user)}
                    >
                      <IconX size={10} />
                    </LegacyActionIcon>
                  }
                >
                  {user.username}
                </Badge>
              ))}
            </Group>
          )}
          <Text c="dimmed" size="xs">
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
    <div className="flex flex-col gap-2">
      <Text>Allowed Browsing Levels</Text>
      <Paper withBorder p={0} className={classes.root}>
        {browsingLevels.map((level) => {
          const isSelected = Flags.hasFlag(browsingLevel, level);
          return (
            <Group
              justify="space-between"
              key={level}
              p="md"
              onClick={() => toggleBrowsingLevel(level)}
              className={clsx({ [classes.active]: isSelected })}
              wrap="nowrap"
            >
              <Group wrap="nowrap">
                <Text fw={700} w={50} ta="center">
                  {browsingLevelLabels[level]}
                </Text>
                <Text lh={1.2} size="sm" ta="left" style={{ flex: '1 1' }}>
                  {browsingLevelDescriptions[level]}
                </Text>
              </Group>
              <Text c="green" inline style={{ visibility: !isSelected ? 'hidden' : undefined }}>
                <IconCheck />
              </Text>
            </Group>
          );
        })}
      </Paper>
    </div>
  );
}
