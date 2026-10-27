import { AspectRatio, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

/** `halloween` -> `Halloween`, `winter-fest` -> `Winter Fest`. */
const eventNameFromTag = (tag: string) =>
  tag
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** Last tile of an event's crucibles row; sized like a CrucibleCard. */
export function HostCrucibleTile({ eventTag, signedIn }: { eventTag: string; signedIn: boolean }) {
  const href = signedIn ? '/crucibles/create' : '/login?returnUrl=/crucibles/create';

  return (
    <AspectRatio ratio={7 / 9}>
      <Link
        href={href}
        className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-blue-6 bg-blue-6/10 p-6 text-center no-underline transition-colors hover:bg-blue-6/20"
      >
        <IconPlus size={32} />
        <Text fw={700} size="lg" inherit>
          Host your own {eventNameFromTag(eventTag)} crucible
        </Text>
        <Text size="sm" c="dimmed">
          Start a challenge, set a prize, let the community compete
        </Text>
      </Link>
    </AspectRatio>
  );
}
