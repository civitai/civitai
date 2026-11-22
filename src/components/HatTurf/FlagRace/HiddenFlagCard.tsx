import { AspectRatio, Button, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import { FlagBadge } from '~/components/HatTurf/FlagRace/FlagBadge';
import type { HiddenFlagReason } from '~/components/HatTurf/FlagRace/useFlagReveal';

const copy: Record<HiddenFlagReason | 'other', string> = {
  preferences: 'Hidden by your content settings',
  browsingLevel: 'Hidden by your browsing level',
  other: 'Hidden for you',
};

/**
 * Stands in for one of today's flags the viewer may not see: the picture stays hidden, but its
 * points and holders still show. One their own hidden users, images or tags hide can be shown
 * anyway (`onShow`); one a creator's block hides cannot.
 */
export function HiddenFlagCard({
  imageId,
  reason,
  onShow,
}: {
  imageId: number;
  reason?: HiddenFlagReason;
  onShow?: () => void;
}) {
  return (
    <AspectRatio ratio={7 / 9}>
      <div
        className="relative flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-dark-4 bg-dark-6 px-2 text-center"
        data-testid="flag-hidden-for-you"
        data-reason={reason ?? 'other'}
      >
        <div className="absolute left-2 top-2">
          <FlagBadge imageId={imageId} />
        </div>
        <IconEyeOff size={20} className="text-dark-2" />
        <Text size="xs" c="dimmed">
          {copy[reason ?? 'other']}
        </Text>
        {reason === 'preferences' && onShow && (
          <Button size="compact-xs" variant="light" mt={4} onClick={onShow}>
            Show anyway
          </Button>
        )}
      </div>
    </AspectRatio>
  );
}
