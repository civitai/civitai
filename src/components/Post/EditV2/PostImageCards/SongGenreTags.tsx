import { Combobox, Select, Text, TextInput, UnstyledButton, useCombobox } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { withMetadata } from '~/components/Post/EditV2/PostImageCards/song-metadata';
import type { PostEditImageDetail } from '~/server/services/post.service';
import {
  readSongGenre,
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

/** A song's genre (required to publish) and its own tags. */
export function SongGenreTags({ image }: { image: PostEditImageDetail }) {
  const { id } = image;
  const genre = readSongGenre(image.metadata);
  // An upload's result can reach the store before the editor read that carries the tags.
  const songTags = image.songTags ?? [];
  const updateImage = usePostEditStore((state) => state.updateImage);

  const setStored = (changes: { genre?: SongGenre; tags?: SongTagRow[] }) =>
    updateImage(id, (draft) => {
      if ('genre' in changes)
        draft.metadata = withMetadata(draft.metadata, { genre: changes.genre });
      if (changes.tags) draft.songTags = changes.tags;
    });

  const setGenre = trpc.post.setSongGenre.useMutation({
    onMutate: ({ genre }) => setStored({ genre }),
    onSuccess: ({ tags }) => setStored({ tags }),
    onError: (error) => {
      setStored({ genre });
      showErrorNotification({ title: 'Failed to save the genre', error: new Error(error.message) });
    },
  });
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
    <div className="flex flex-wrap items-start gap-2">
      <Select
        aria-label="Genre"
        placeholder="Pick a genre"
        data={[...SONG_GENRES]}
        value={genre ?? null}
        onChange={(value) => {
          if (value && value !== genre) setGenre.mutate({ id, genre: value as SongGenre });
        }}
        allowDeselect={false}
        searchable
        error={!genre ? SONG_GENRE_REQUIRED_MESSAGE : undefined}
        // Inside the card, which clips: the theme renders Popover dropdowns in place.
        comboboxProps={{ withinPortal: true }}
        w={200}
        radius={4}
        classNames={{ input: 'h-[34px] min-h-[34px] text-[13px]', error: 'text-xs' }}
        // The error state colours the border, placeholder and message; typed search text stays
        // the normal text colour.
        styles={{ input: { color: 'var(--mantine-color-text)' } }}
      />
      <div className="flex min-h-[34px] flex-wrap items-center gap-1.5">
        {songTags.map((tag) => (
          <span
            key={tag.id}
            className="flex items-center gap-1 rounded bg-gray-1 py-[3px] pl-2 pr-1.5 text-xs text-gray-9 dark:bg-dark-5 dark:text-dark-0"
          >
            {tag.name}
            <UnstyledButton
              aria-label={`Remove tag ${tag.name}`}
              // A 24px target around the 11px icon; the negative margins keep the chip's size.
              className="-my-1 -mr-1.5 flex size-6 items-center justify-center rounded text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-dark-0"
              disabled={removeTag.isPending}
              onClick={() => removeTag.mutate({ id, tagId: tag.id })}
            >
              <IconX size={11} />
            </UnstyledButton>
          </span>
        ))}
        {songTags.length < SONG_TAG_LIMIT ? (
          <SongTagInput
            taken={[
              ...songTags.map((tag) => tag.name),
              ...(genre ? [songGenreTagName(genre)] : []),
            ]}
            disabled={addTag.isPending}
            onAdd={(name) => addTag.mutate({ id, name })}
          />
        ) : (
          <Text size="xs" c="dimmed" title={SONG_TAG_LIMIT_MESSAGE}>
            {SONG_TAG_LIMIT}/{SONG_TAG_LIMIT} tags
          </Text>
        )}
      </div>
    </div>
  );
}

function SongTagInput({
  taken,
  disabled,
  onAdd,
}: {
  taken: string[];
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
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

  const submit = (value: string) => {
    const name = value.trim().toLowerCase();
    setQuery('');
    combobox.closeDropdown();
    if (name && !taken.includes(name)) onAdd(name);
  };

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={submit}
      // Inside the card, which clips: the theme renders Popover dropdowns in place.
      withinPortal
    >
      <Combobox.Target>
        <TextInput
          aria-label="Add a tag"
          placeholder="Add a tag"
          value={query}
          maxLength={SONG_TAG_MAX_LENGTH}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            combobox.openDropdown();
            combobox.resetSelectedOption();
          }}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
          // Runs before the combobox's own Enter handling, which submits a highlighted option:
          // the typed text is added only when no option is highlighted.
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || combobox.getSelectedOptionIndex() !== -1) return;
            e.preventDefault();
            if (typed) submit(query);
          }}
          radius={4}
          w={140}
          classNames={{ input: 'h-[34px] min-h-[34px] text-[13px]' }}
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
  );
}
