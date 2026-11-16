import { Autocomplete, Select, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { withMetadata } from '~/components/Post/EditV2/PostImageCards/SongDetails';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { NsfwLevel } from '~/server/common/enums';
import {
  readSongGenre,
  SONG_GENRE_REQUIRED_MESSAGE,
  SONG_GENRES,
  SONG_TAG_LIMIT,
  SONG_TAG_MAX_LENGTH,
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
        error={!genre ? SONG_GENRE_REQUIRED_MESSAGE : undefined}
        // Inside the card, which clips: the theme renders Popover dropdowns in place.
        comboboxProps={{ withinPortal: true }}
        w={200}
        radius={4}
        classNames={{ input: 'h-[34px] min-h-[34px] text-[13px]', error: 'text-xs' }}
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
              className="flex rounded text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-dark-0"
              disabled={removeTag.isPending}
              onClick={() => removeTag.mutate({ id, tagId: tag.id })}
            >
              <IconX size={11} />
            </UnstyledButton>
          </span>
        ))}
        {songTags.length < SONG_TAG_LIMIT && (
          <SongTagInput
            taken={songTags.map((tag) => tag.name)}
            disabled={addTag.isPending}
            onAdd={(name) => addTag.mutate({ id, name })}
          />
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
  // Only plain PG tags can go on a song, so only those are suggested.
  const { data } = trpc.post.getTags.useQuery(
    { query: debounced, nsfwLevel: NsfwLevel.PG },
    { enabled: debounced.length > 1 }
  );
  const suggestions = [...new Set((data ?? []).map((tag) => tag.name))].filter(
    (name) => !taken.includes(name)
  );

  const submit = (value: string) => {
    const name = value.trim().toLowerCase();
    setQuery('');
    if (name && !taken.includes(name)) onAdd(name);
  };

  return (
    <Autocomplete
      aria-label="Add a tag"
      placeholder="Add a tag"
      value={query}
      onChange={setQuery}
      data={suggestions}
      limit={8}
      maxLength={SONG_TAG_MAX_LENGTH}
      disabled={disabled}
      onOptionSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && query.trim()) {
          e.preventDefault();
          submit(query);
        }
      }}
      comboboxProps={{ withinPortal: true }}
      size="xs"
      radius={4}
      w={140}
    />
  );
}
