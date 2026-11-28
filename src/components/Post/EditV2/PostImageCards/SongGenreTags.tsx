import {
  Badge,
  Combobox,
  Group,
  Select,
  Text,
  TextInput,
  UnstyledButton,
  useCombobox,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import type { PostEditImageDetail } from '~/server/services/post.service';
import {
  SONG_GENRE_REQUIRED_MESSAGE,
  SONG_GENRES,
  SONG_TAG_LIMIT,
  SONG_TAG_LIMIT_MESSAGE,
  SONG_TAG_MAX_LENGTH,
  songGenreTagName,
} from '~/shared/constants/song-genres';
import type { SongGenre } from '~/shared/constants/song-genres';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type SongTagRow = PostEditImageDetail['songTags'][number];

/** Writes a song's genre and tags back to the editor's store. */
function useSetSongStored(id: number) {
  const updateImage = usePostEditStore((state) => state.updateImage);
  return (changes: { genre?: SongGenre; tags?: SongTagRow[] }) =>
    updateImage(id, (draft) => {
      if ('genre' in changes) draft.genre = changes.genre ?? null;
      if (changes.tags) draft.songTags = changes.tags;
    });
}

/** A song's genre, required to publish. */
export function SongGenreSelect({ image }: { image: PostEditImageDetail }) {
  const { id } = image;
  const genre = image.genre ?? undefined;
  const setStored = useSetSongStored(id);
  // As `assertSongsHaveGenres`: the genre is required to publish, so a live post asks for none.
  const live = usePostEditStore(
    (state) => !!state.post?.publishedAt && new Date(state.post.publishedAt) <= new Date()
  );

  const setGenre = trpc.post.setSongGenre.useMutation({
    onMutate: ({ genre }) => setStored({ genre }),
    onSuccess: ({ tags }) => setStored({ tags }),
    onError: (error) => {
      setStored({ genre });
      showErrorNotification({ title: 'Failed to save the genre', error: new Error(error.message) });
    },
  });

  return (
    <Select
      label="Genre"
      placeholder="Pick a genre"
      data={[...SONG_GENRES]}
      value={genre ?? null}
      onChange={(value) => {
        if (value && value !== genre) setGenre.mutate({ id, genre: value as SongGenre });
      }}
      allowDeselect={false}
      searchable
      error={!genre && !live ? SONG_GENRE_REQUIRED_MESSAGE : undefined}
      // Inside the card, which clips: the theme renders Popover dropdowns in place.
      comboboxProps={{ withinPortal: true }}
      radius={4}
      classNames={{
        label: 'text-xs font-semibold text-black dark:text-white mb-1',
        input: 'h-[34px] min-h-[34px] text-[13px]',
        error: 'text-xs',
      }}
      // The error state colours the border, placeholder and message; typed search text stays
      // the normal text colour.
      styles={{ input: { color: 'var(--mantine-color-text)' } }}
    />
  );
}

/** A song's rating and its own tags, in the row images and videos show their tags in. */
export function SongTags({ image }: { image: PostEditImageDetail }) {
  const { id, nsfwLevel } = image;
  const genre = image.genre ?? undefined;
  // An upload's result can reach the store before the editor read that carries the tags.
  const songTags = image.songTags ?? [];
  const setStored = useSetSongStored(id);
  const onTagsSaved = { onSuccess: ({ tags }: { tags: SongTagRow[] }) => setStored({ tags }) };
  const addTag = trpc.post.addSongTag.useMutation({
    ...onTagsSaved,
    onError: (error) =>
      showErrorNotification({ title: 'Failed to add the tag', error: new Error(error.message) }),
  });
  const removeTag = trpc.post.removeSongTag.useMutation({
    ...onTagsSaved,
    onError: (error) =>
      showErrorNotification({ title: 'Failed to remove the tag', error: new Error(error.message) }),
  });

  return (
    <Group gap={4}>
      {/* Not clickable, unlike an image's: a song's level is set by its scans and disputes. */}
      {!!nsfwLevel && <BrowsingLevelBadge radius="xs" browsingLevel={nsfwLevel} />}
      {songTags.length < SONG_TAG_LIMIT ? (
        <SongTagAdd
          taken={[...songTags.map((tag) => tag.name), ...(genre ? [songGenreTagName(genre)] : [])]}
          disabled={addTag.isPending}
          onAdd={(name) => addTag.mutate({ id, name })}
        />
      ) : (
        <Text size="xs" c="dimmed" title={SONG_TAG_LIMIT_MESSAGE}>
          {SONG_TAG_LIMIT}/{SONG_TAG_LIMIT} tags
        </Text>
      )}
      {songTags.map((tag) => (
        <SongTagChip
          key={tag.id}
          name={tag.name}
          disabled={removeTag.isPending}
          onRemove={() => removeTag.mutate({ id, tagId: tag.id })}
        />
      ))}
    </Group>
  );
}

/** A tag chip in the colours of an image's PG tag, with a remove button in place of the votes. */
function SongTagChip({
  name,
  disabled,
  onRemove,
}: {
  name: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark', { getInitialValueInEffect: false });
  const colors = theme.variantColorResolver({
    color: 'gray',
    variant: colorScheme === 'dark' ? 'filled' : 'light',
    theme,
  });
  return (
    <Badge
      radius="sm"
      pl={8}
      pr={0}
      style={{ backgroundColor: colors.background, color: colors.color }}
      rightSection={
        <UnstyledButton
          aria-label={`Remove tag ${name}`}
          // A 24px target around the icon; the negative margins keep the chip's size.
          className="-my-1 flex size-6 items-center justify-center rounded opacity-70 hover:opacity-100"
          disabled={disabled}
          onClick={onRemove}
        >
          <IconX size={12} strokeWidth={2.5} />
        </UnstyledButton>
      }
    >
      {name}
    </Badge>
  );
}

/** The "+ Tag" badge of an image's tags, opening a field with the song tag suggestions. */
function SongTagAdd({
  taken,
  disabled,
  onAdd,
}: {
  taken: string[];
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
  const theme = useMantineTheme();
  const [adding, { open, close }] = useDisclosure(false);
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query.trim(), 300);
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  // Only tags an owner may attach come back, so every suggestion can be added.
  const { data } = trpc.post.searchSongTags.useQuery(
    { query: debounced },
    { enabled: debounced.length > 1 }
  );
  const typed = query.trim().toLowerCase();
  const suggestions = (data ?? [])
    .map((tag) => tag.name)
    .filter((name) => !taken.includes(name) && (!typed || name.startsWith(typed)));
  const colors = theme.variantColorResolver({ color: 'blue', variant: 'light', theme });

  const submit = (value: string) => {
    const name = value.trim().toLowerCase();
    setQuery('');
    combobox.closeDropdown();
    if (name && !taken.includes(name)) onAdd(name);
  };

  return (
    <Badge
      radius="xs"
      className="cursor-pointer px-[5px]"
      style={{ backgroundColor: colors.background, color: colors.color }}
      onClick={!adding ? open : undefined}
    >
      <Group gap={4} wrap="nowrap">
        <IconPlus size={14} strokeWidth={2.5} />
        {!adding ? (
          <span>Tag</span>
        ) : (
          <Combobox
            store={combobox}
            onOptionSubmit={submit}
            // Inside the card, which clips: the theme renders Popover dropdowns in place.
            withinPortal
          >
            <Combobox.Target>
              <TextInput
                aria-label="Add a tag"
                placeholder="Type your tag"
                variant="unstyled"
                value={query}
                maxLength={SONG_TAG_MAX_LENGTH}
                disabled={disabled}
                autoFocus
                onChange={(e) => {
                  setQuery(e.currentTarget.value);
                  combobox.openDropdown();
                  combobox.resetSelectedOption();
                }}
                onBlur={() => {
                  combobox.closeDropdown();
                  setQuery('');
                  close();
                }}
                // Runs before the combobox's own Enter handling, which submits a highlighted
                // option: the typed text is added only when no option is highlighted.
                onKeyDown={(e) => {
                  if (e.key === 'Escape') e.currentTarget.blur();
                  if (e.key !== 'Enter' || combobox.getSelectedOptionIndex() !== -1) return;
                  e.preventDefault();
                  if (typed) submit(query);
                }}
                classNames={{ input: 'h-auto min-h-0 font-bold uppercase text-[11px]' }}
              />
            </Combobox.Target>
            <Combobox.Dropdown hidden={!suggestions.length}>
              <Combobox.Options>
                {suggestions.map((name) => (
                  <Combobox.Option value={name} key={name}>
                    {name}
                  </Combobox.Option>
                ))}
              </Combobox.Options>
            </Combobox.Dropdown>
          </Combobox>
        )}
      </Group>
    </Badge>
  );
}
