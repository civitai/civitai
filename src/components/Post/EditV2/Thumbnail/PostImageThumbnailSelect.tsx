import { Button, Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useScrubberStore } from '~/components/VideoScrubber/scrubber.store';
import { VideoScrubber } from '~/components/VideoScrubber/VideoScrubber';

export function PostImageThumbnailSelect({ src, duration, width, height }: Props) {
  const dialog = useDialogContext();
  const video = useScrubberStore((state) => state.video);
  const scrubber = useScrubberStore((state) => state.scrubber);
  const setVideoState = useScrubberStore((state) => state.setVideoState);
  const resetScrubber = useScrubberStore((state) => state.reset);

  if (video.src !== src) setVideoState({ src, duration, width, height });

  console.log({ scrubber, video });

  const handleSubmit = () => {
    dialog.onClose();
    resetScrubber();
  };

  return (
    <Modal title="Select Thumbnail" {...dialog}>
      <VideoScrubber {...video} canvasWidth={600} />
      <div className="flex w-full justify-end">
        <Button onClick={handleSubmit}>Submit</Button>
      </div>
    </Modal>
  );
}

type Props = {
  src: string;
  duration: number;
  width: number;
  height: number;
};
