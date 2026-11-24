import { UnstyledButton } from '@mantine/core';
import { IconPlayerPlayFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import { openDialog } from '~/components/Dialog/openDialog';
import { filmLength } from '~/components/Events/ScoredEvent/scored-event.utils';

/**
 * A glass play circle over a card's art, with "Watch · m:ss" under it, that opens the film in the
 * site's video modal. The caller places it.
 */
export function ArtPlayButton({
  video,
  title,
  duration,
  className,
  testId,
}: {
  /** A full URL or a CDN id. */
  video: string;
  title: string;
  /** Seconds; 0 or absent hides the label. */
  duration?: number;
  className?: string;
  /** `<testId>-play` on the button, `<testId>-duration` on the label. */
  testId?: string;
}) {
  const seconds = duration !== undefined && Number.isFinite(duration) ? Math.round(duration) : 0;
  return (
    <UnstyledButton
      onClick={() =>
        openDialog(() => import('~/components/Events/ScoredEvent/HatTurfVideoModal'), {
          video,
          title,
        })
      }
      aria-label={`Watch the ${title} video`}
      data-testid={testId && `${testId}-play`}
      className={clsx('group z-[3]', className)}
    >
      <span className="flex flex-col items-center gap-1.5">
        <span className="flex size-[52px] items-center justify-center rounded-full border border-solid border-white/50 bg-white/30 text-white shadow-lg backdrop-blur-md transition-transform group-hover:scale-110">
          <IconPlayerPlayFilled size={22} />
        </span>
        {seconds > 0 && (
          <span
            className="rounded-full bg-dark-9/70 px-2.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm"
            data-testid={testId && `${testId}-duration`}
          >
            Watch · {filmLength(seconds)}
          </span>
        )}
      </span>
    </UnstyledButton>
  );
}
