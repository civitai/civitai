import { Button, useComputedColorScheme } from '@mantine/core';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { ComicGenre } from '~/shared/utils/prisma/enums';
import { formatGenreLabel } from '~/utils/comic-helpers';

const genres = Object.values(ComicGenre);

export function ComicGenreScroller({
  value,
  onChange,
}: {
  value?: string;
  onChange: (genre: string | undefined) => void;
}) {
  const colorScheme = useComputedColorScheme('dark');

  return (
    <TwScrollX className="flex gap-1">
      <Button
        className="overflow-visible uppercase"
        variant={!value ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
        color={!value ? 'blue' : 'gray'}
        onClick={() => onChange(undefined)}
        size="compact-sm"
      >
        All
      </Button>
      {genres.map((g) => {
        const active = value === g;
        return (
          <Button
            key={g}
            className="overflow-visible uppercase"
            variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
            color={active ? 'blue' : 'gray'}
            onClick={() => onChange(active ? undefined : g)}
            size="compact-sm"
          >
            {formatGenreLabel(g)}
          </Button>
        );
      })}
    </TwScrollX>
  );
}
