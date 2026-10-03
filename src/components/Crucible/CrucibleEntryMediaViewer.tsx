import { ActionIcon, Modal, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { MediaType } from '~/shared/utils/prisma/enums';

/** An entry's media and nothing that identifies who made it. */
export type CrucibleEntryMedia = {
  entryId: number;
  url: string;
  name: string | null;
  type: MediaType;
  metadata?: MixedObject | null;
};

export function CrucibleEntryMediaViewer({
  media,
  index,
  hasMore = false,
  onIndexChange,
  onClose,
}: {
  media: CrucibleEntryMedia[];
  /** The item on display, or `null` when the viewer is closed. */
  index: number | null;
  /** More entries exist than `media` holds, so the count is a floor. */
  hasMore?: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const item = index !== null ? media[index] : undefined;
  const opened = !!item;
  const prev = index !== null && index > 0 ? index - 1 : undefined;
  const next = index !== null && index < media.length - 1 ? index + 1 : undefined;

  useHotkeys(
    opened
      ? [
          ['ArrowLeft', () => prev !== undefined && onIndexChange(prev)],
          ['ArrowRight', () => next !== undefined && onIndexChange(next)],
        ]
      : [],
    // A focused video's native controls seek with the arrow keys.
    ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO']
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      withOverlay={false}
      title="Entry"
      closeButtonProps={{ 'aria-label': 'Close entry viewer' }}
      styles={{
        inner: { position: 'absolute' },
        content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 16 },
      }}
    >
      {item && index !== null && (
        <div data-testid="crucible-entry-media-viewer" className="flex min-h-0 flex-1 flex-col">
          <Text size="sm" c="dimmed" mb="xs">
            {index + 1} / {media.length}
            {hasMore && '+'}
          </Text>
          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            <EdgeMedia2
              key={item.entryId}
              src={item.url}
              name={item.name}
              type={item.type}
              metadata={item.metadata}
              html5Controls
              muted
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              wrapperProps={{ className: 'flex size-full items-center justify-center' }}
              // Autoplay explicitly: EdgeVideo's in-view check watches the page scroller, which
              // a portalled modal is outside of, so it would never start.
              videoProps={{ autoPlay: true, hoverPlay: false }}
            />
            <NavButton
              label="Previous entry"
              disabled={prev === undefined}
              onClick={() => prev !== undefined && onIndexChange(prev)}
              className="left-2"
            >
              <IconChevronLeft size={24} />
            </NavButton>
            <NavButton
              label="Next entry"
              disabled={next === undefined}
              onClick={() => next !== undefined && onIndexChange(next)}
              className="right-2"
            >
              <IconChevronRight size={24} />
            </NavButton>
          </div>
        </div>
      )}
    </Modal>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <ActionIcon
      variant="filled"
      color="dark"
      size="xl"
      radius="xl"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx('absolute top-1/2 z-10 -translate-y-1/2', className)}
    >
      {children}
    </ActionIcon>
  );
}
