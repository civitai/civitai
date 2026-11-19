import { SegmentedControl, VisuallyHidden } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconLayoutGrid, IconList } from '@tabler/icons-react';
import { Tooltip } from '~/components/MantineOverlays';

export type SongFeedView = 'card' | 'list';

/** The music feed's view, kept per browser. */
export function useSongFeedView() {
  return useLocalStorage<SongFeedView>({ key: 'music-feed-view', defaultValue: 'card' });
}

function ViewOption({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <span className="flex items-center justify-center">
        {icon}
        <VisuallyHidden>{label}</VisuallyHidden>
      </span>
    </Tooltip>
  );
}

/** Grid / list switch of the music feed toolbar (Pencil `YzE3g`). */
export function SongViewToggle({
  value,
  onChange,
}: {
  value: SongFeedView;
  onChange: (value: SongFeedView) => void;
}) {
  return (
    <SegmentedControl
      size="xs"
      radius="md"
      value={value}
      onChange={(next) => onChange(next as SongFeedView)}
      data={[
        {
          value: 'card',
          label: <ViewOption label="Card view" icon={<IconLayoutGrid size={16} />} />,
        },
        { value: 'list', label: <ViewOption label="List view" icon={<IconList size={16} />} /> },
      ]}
    />
  );
}
