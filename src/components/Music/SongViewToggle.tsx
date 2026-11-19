import { useLocalStorage } from '@mantine/hooks';
import { IconLayoutGrid, IconList } from '@tabler/icons-react';
import clsx from 'clsx';
import { Tooltip } from '~/components/MantineOverlays';
import { songTextBright, songTextDimmed } from '~/components/Music/song-styles';

export type SongFeedView = 'card' | 'list';

export function useSongFeedView() {
  return useLocalStorage<SongFeedView>({ key: 'music-feed-view', defaultValue: 'card' });
}

const OPTIONS = [
  { value: 'card', label: 'Card view', Icon: IconLayoutGrid },
  { value: 'list', label: 'List view', Icon: IconList },
] as const;

// Pencil `YzE3g`.
export function SongViewToggle({
  value,
  onChange,
}: {
  value: SongFeedView;
  onChange: (value: SongFeedView) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      className="flex shrink-0 gap-0.5 rounded border border-solid border-gray-3 bg-gray-0 p-[2px] dark:border-dark-4 dark:bg-dark-6"
    >
      {OPTIONS.map(({ value: option, label, Icon }) => {
        const checked = value === option;
        return (
          <Tooltip key={option} label={label}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              onClick={() => onChange(option)}
              className={clsx(
                'flex h-[26px] w-7 items-center justify-center rounded',
                checked ? ['bg-gray-1 dark:bg-dark-5', songTextBright] : songTextDimmed
              )}
            >
              <Icon size={14} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
