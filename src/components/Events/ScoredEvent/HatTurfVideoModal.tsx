import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { HERO_VIDEO_OPTIONS } from '~/components/Events/ScoredEvent/scored-event.utils';

/** Plays the Hat Turf song: a full URL in a plain player, a CDN id through EdgeVideo. */
export default function HatTurfVideoModal({ video, title }: { video: string; title: string }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title={title} size="xl" radius="md" centered>
      {/^https?:\/\//.test(video) ? (
        <video
          src={video}
          controls
          autoPlay
          playsInline
          className="w-full rounded-md"
          data-testid="hat-turf-video"
        />
      ) : (
        <EdgeVideo
          src={video}
          options={HERO_VIDEO_OPTIONS}
          html5Controls
          controls
          autoPlay
          muted={false}
          hoverPlay={false}
          disableWebm
          className="w-full rounded-md"
          wrapperProps={{ className: 'w-full' }}
        />
      )}
    </Modal>
  );
}
