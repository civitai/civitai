import { Anchor, Badge, Popover, Text } from '@mantine/core';
import Link from 'next/link';

/**
 * That this one cost nothing, and where the owner changes that.
 *
 * Shared by both review queues and the sticker overlay so the fact reads the
 * same everywhere it appears — same colour, same words, same explanation.
 *
 * The popover exists because a queue is where a creator first meets a free
 * placement, arriving from a notification, and "why is this free and how do I
 * stop it" otherwise has no answer on the page they are standing on.
 */
export function PlacementFreeBadge({
  /** What was placed here: `placement` on stickers, `submission` on galleries. */
  noun,
  /**
   * Solid rather than tinted. `light` is a translucent fill, which is legible on
   * a queue card and unreadable over artwork — so the copy on an image asks for
   * this, and nothing else should need it.
   */
  solid = false,
}: {
  noun: 'placement' | 'submission';
  solid?: boolean;
}) {
  return (
    // `withinPortal` explicitly: the repo theme sets `withinPortal: false` for
    // every Popover (`ThemeProvider.tsx:35`), and this one opens inside a queue
    // card that clips it — the dropdown came out truncated.
    <Popover width={240} withArrow shadow="md" position="top" withinPortal>
      <Popover.Target>
        {/* A real button, so Enter and Space reach it and it lands in the tab
            order — `Popover.Target` supplies the click itself. */}
        <Badge
          component="button"
          type="button"
          size="sm"
          variant={solid ? 'filled' : 'light'}
          color="blue"
          className="w-fit cursor-pointer"
        >
          Free {noun}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown>
        {/* Two short lines on purpose. It sits over a decision, not beside an
            article, and the long version was read past. */}
        <Text size="sm" style={{ whiteSpace: 'normal' }}>
          They spent their one free {noun} of the day here. It earns you no Buzz.
        </Text>
        <Anchor component={Link} href="/user/account" size="sm" mt={6} className="block">
          Choose how many free ones you take
        </Anchor>
      </Popover.Dropdown>
    </Popover>
  );
}
