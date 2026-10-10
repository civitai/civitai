import { Modal, Stack } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { JoinEventButton } from '~/components/Events/ScoredEvent/JoinEventButton';
import { HERO_VIDEO_OPTIONS } from '~/components/Events/ScoredEvent/scored-event.utils';

/** The event's film, opened from the hero. Plays with sound: the click that opened it allows that. */
export default function EventVideoModal({
  video,
  onJoin,
}: {
  video: { id: string; title: string };
  /** Offered under the film to a viewer who has not joined yet. */
  onJoin?: () => unknown;
}) {
  const dialog = useDialogContext();
  const [joining, setJoining] = useState(false);

  const join = async () => {
    if (!onJoin) return;
    setJoining(true);
    try {
      await onJoin();
      dialog.onClose();
    } finally {
      setJoining(false);
    }
  };

  return (
    <Modal {...dialog} title={video.title} size="xl" radius="md" centered>
      <Stack gap="md" align="center">
        <EdgeVideo
          src={video.id}
          options={HERO_VIDEO_OPTIONS}
          html5Controls
          controls
          // EdgeVideo's in-view check watches the page scroller, which a portalled modal is outside
          // of, so it is told to play.
          autoPlay
          muted={false}
          hoverPlay={false}
          disableWebm
          className="w-full rounded-md"
          wrapperProps={{ className: 'w-full' }}
        />
        {onJoin && <JoinEventButton onClick={join} loading={joining} />}
      </Stack>
    </Modal>
  );
}
