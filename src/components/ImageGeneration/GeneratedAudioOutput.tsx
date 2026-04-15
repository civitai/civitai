import { IconMusic } from '@tabler/icons-react';

import type { AudioBlob } from '~/shared/orchestrator/workflow-data';

export function GeneratedAudioOutput({ image }: { image: AudioBlob }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-4 bg-dark-6 p-4">
      <IconMusic size={48} className="text-dimmed" />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio src={image.url} controls className="w-full max-w-[280px]" preload="metadata" />
    </div>
  );
}
