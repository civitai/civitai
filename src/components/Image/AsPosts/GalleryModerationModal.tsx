import {
  ActionIcon,
  Autocomplete,
  Badge,
  Card,
  Chip,
  Group,
  Loader,
  Modal,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import React, { useRef, useState, useMemo } from 'react';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { moderationCategories, ModerationCategory } from '~/libs/moderation';
import { trpc } from '~/utils/trpc';
import { useModelGallerySettings } from './gallery.utils';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { isDefined } from '~/utils/type-guards';

export function GalleryModerationModal({ opened, onClose }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="Gallery Moderation Preferences">
      <Stack>
        <HiddenTagsSection />
        <HiddenUsersSection />
        <MatureContentSection />
      </Stack>
    </Modal>
  );
}

type Props = { opened: boolean; onClose: VoidFunction };

export function HiddenTagsSection() {
  const { model } = useImagesAsPostsInfiniteContext();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const tags = useHiddenPreferencesData().tag;
  const moderationTags = tags.filter((x) => x.type === 'moderated');
  const { data: gallerySettings, toggleGallerySettings } = useModelGallerySettings({
    modelId: model.id,
  });

  const { data, isLoading } = trpc.tag.getAll.useQuery({
    entityType: ['Image'],
    query: debouncedSearch.toLowerCase().trim(),
    not: gallerySettings?.hiddenTags.map((x) => x.id),
  });
  const options =
    data?.items
      .filter((x) => !gallerySettings?.hiddenTags.some((y) => y.id === x.id))
      .map(({ id, name }) => ({ id, value: name })) ?? [];

  const hiddenTags =
    gallerySettings?.hiddenTags.filter((tag) => !moderationTags.find((t) => t.id === tag.id)) ?? [];

  const handleToggleBlockedTag = async (tag: { id: number; name: string }) => {
    await toggleGallerySettings({ modelId: model.id, tags: [tag] }).catch(() => null);
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

export function HiddenUsersSection() {
  const { model } = useImagesAsPostsInfiniteContext();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data: gallerySettings, toggleGallerySettings } = useModelGallerySettings({
    modelId: model.id,
  });

  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: debouncedSearch !== '' }
  );
  const options =
    data?.filter((x) => x.username).map(({ id, username }) => ({ id, value: username ?? '' })) ??
    [];

  const handleToggleBlocked = async (user: { id: number; username: string | null }) => {
    await toggleGallerySettings({ modelId: model.id, users: [user] }).catch(() => null);
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

function MatureContentSection() {
  const { model } = useImagesAsPostsInfiniteContext();

  const tags = useHiddenPreferencesData().tag;
  const moderationTags = tags.filter((x) => x.type === 'moderated');
  const { hiddenTags, toggleGallerySettings } = useModelGallerySettings({ modelId: model.id });
  const preferences = useMemo(
    () =>
      moderationTags.reduce<Record<string, boolean>>(
        (acc, value) => ({ ...acc, [value.name]: !hiddenTags.get(value.id) }),
        {}
      ) ?? {},
    [moderationTags, hiddenTags]
  );

  const handleAllToggle = async () => {
    await toggleGallerySettings({ modelId: model.id, tags: moderationTags }).catch(() => null);
  };

  const handleCategoryToggle = async (name: string, children?: ModerationCategory[]) => {
    if (!children) return;

    const childValues = children.map((x) => x.value);
    const valueTag = moderationTags.find((x) => x.name === name);
    const data = [valueTag, ...moderationTags.filter((x) => childValues.includes(x.name))].filter(
      isDefined
    );

    await toggleGallerySettings({ modelId: model.id, tags: data }).catch(() => null);
  };

  const handleChipToggle = async (name: string) => {
    const tag = moderationTags.find((x) => x.name === name);
    if (!!tag) await toggleGallerySettings({ modelId: model.id, tags: [tag] }).catch(() => null);
  };

  return (
    <Card key="nsfw" withBorder pb={0}>
      <Card.Section withBorder inheritPadding py="xs">
        <Group position="apart">
          <Text weight={500}>Mature Content</Text>
          <Switch
            checked={moderationTags.some((x) => preferences[x.name])}
            onChange={handleAllToggle}
          />
        </Group>
      </Card.Section>
      {moderationCategories
        .filter((x) => !x.hidden)
        .map((category) => {
          const categoryChecked = category.children?.some((x) => preferences[x.value]);
          return (
            <React.Fragment key={category.value}>
              <Card.Section withBorder inheritPadding py="xs">
                <Group position="apart">
                  <Text weight={500}>{category.label}</Text>
                  <Switch
                    checked={categoryChecked}
                    onChange={() => handleCategoryToggle(category.value, category.children)}
                  />
                </Group>
              </Card.Section>
              {preferences && categoryChecked && !!category.children?.length && (
                <Card.Section inheritPadding py="md">
                  <Text size="xs" weight={500} mb="xs" mt={-8} color="dimmed">
                    Toggle all that you are comfortable seeing
                  </Text>
                  <Group spacing={5}>
                    {category.children
                      .filter((x) => !x.hidden)
                      .map((child) => (
                        <Chip
                          variant="filled"
                          radius="xs"
                          size="xs"
                          key={child.value}
                          onChange={() => handleChipToggle(child.value)}
                          checked={preferences?.[child.value] ?? false}
                        >
                          {child.label}
                        </Chip>
                      ))}
                  </Group>
                </Card.Section>
              )}
            </React.Fragment>
          );
        })}
    </Card>
  );
}
