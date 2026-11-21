import { AspectRatio, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import { FlagBadge } from '~/components/HatTurf/FlagRace/FlagBadge';

/**
 * Stands in for one of today's flags the viewer may not see (its creator blocked them, or a hidden
 * preference took it out): the picture stays hidden, but its points and holders still show.
 */
export function HiddenFlagCard({ imageId }: { imageId: number }) {
  return (
    <AspectRatio ratio={7 / 9}>
      <div
        className="relative flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-dark-4 bg-dark-6 text-center"
        data-testid="flag-hidden-for-you"
      >
        <div className="absolute left-2 top-2">
          <FlagBadge imageId={imageId} />
        </div>
        <IconEyeOff size={20} className="text-dark-2" />
        <Text size="xs" c="dimmed">
          Hidden for you
        </Text>
      </div>
    </AspectRatio>
  );
}
