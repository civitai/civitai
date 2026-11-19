import { Title } from '@mantine/core';
import clsx from 'clsx';
import { SortFilter } from '~/components/Filters/SortFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useImageFilters, useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { SONG_ROW_HEIGHT, SongRow } from '~/components/Music/SongRow';
import { songTextBright } from '~/components/Music/song-styles';
import { SongViewToggle, useSongFeedView } from '~/components/Music/SongViewToggle';
import { TagChipRow } from '~/components/Tags/TagChipRow';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SONG_GENRES } from '~/shared/constants/song-genres';
import { MediaType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

const ALL_MUSIC = 'All music';
const SONG_ROWS = { render: SongRow, height: SONG_ROW_HEIGHT };
// Stands for a `?tags=` the chips cannot show (several tags), so neither All nor a genre lights up.
const UNLISTED_TAGS = 'unlisted';

/** `/music`: the title row, genre chips and the audio feed. */
export function MusicFeedPage() {
  const features = useFeatureFlags();
  const { hidden: _hidden, ...filters } = useImageFilters('images');
  const { query, replace } = useImageQueryParams();
  const [view, setView] = useSongFeedView();
  // `!!`: an off flag is absent from FeatureAccess, and `enabled: undefined` reads as enabled.
  const { data: genreTagIds, isLoading } = trpc.image.getSongGenreTags.useQuery(undefined, {
    enabled: !!features.music,
  });

  const tagIds = query.tags ?? [];
  const activeId = tagIds.length > 1 ? UNLISTED_TAGS : tagIds[0];
  const genres = SONG_GENRES.flatMap((genre) => {
    const id = genreTagIds?.[genre];
    return id ? [{ id, label: genre }] : [];
  });
  const listName = genres.find((genre) => genre.id === activeId)?.label ?? ALL_MUSIC;

  return (
    <>
      <Meta
        title="Civitai Music | AI-Generated Songs"
        description="Listen to songs made by the Civitai community"
        canonical="/music"
      />
      <MasonryContainer>
        {/* Pencil `JzhET` (1440) and `hiEzh` (390): sections 48px apart, 22px on a phone. */}
        <div className="flex flex-col gap-[22px] sm:gap-12">
          <Title
            order={1}
            className={clsx('text-4xl font-extrabold sm:text-5xl sm:font-bold', songTextBright)}
          >
            Music
          </Title>
          <TagChipRow
            items={genres}
            activeId={activeId}
            onSelect={(item) => replace({ tags: item.id === activeId ? [] : [item.id as number] })}
            onClear={() => replace({ tags: [] })}
            loading={isLoading}
            variant="outline"
          />
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Title order={2} className={clsx('text-3xl font-bold', songTextBright)}>
                {listName}
              </Title>
              <div className="flex flex-wrap items-center gap-2">
                <SongViewToggle value={view} onChange={setView} />
                <SortFilter type="images" />
                <MediaFiltersDropdown filterType="images" hideMediaTypes size="compact-sm" isFeed />
              </div>
            </div>
            <IsClient>
              <ImagesInfinite
                filters={{ ...filters, types: [MediaType.audio] }}
                listItem={view === 'list' ? SONG_ROWS : undefined}
                songListName={listName}
                showEof
              />
            </IsClient>
          </section>
        </div>
      </MasonryContainer>
    </>
  );
}
