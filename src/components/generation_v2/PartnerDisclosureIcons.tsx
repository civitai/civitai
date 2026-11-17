import { Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import { IconCloudComputing, IconDatabaseShare } from '@tabler/icons-react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { useState } from 'react';
import { Popover } from '~/components/MantineOverlays';

// Legal's wording, verbatim. Do not add to it or reword it.
export const PARTNER_DISCLOSURE_TEXT = {
  partnerService:
    'A partner runs this model. Your prompt and files go to the partner to create your result.',
  partnerTrains:
    "This partner may use your prompt and results to improve its models. Don't include anything private.",
} as const;

export function PartnerDisclosureIcons({
  partnerService,
  partnerTrains,
  size = 16,
}: {
  partnerService?: boolean;
  partnerTrains?: boolean;
  size?: number;
}) {
  if (!partnerService) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <DisclosureIcon
        icon={IconCloudComputing}
        text={PARTNER_DISCLOSURE_TEXT.partnerService}
        size={size}
      />
      {partnerTrains && (
        <DisclosureIcon
          icon={IconDatabaseShare}
          text={PARTNER_DISCLOSURE_TEXT.partnerTrains}
          size={size}
        />
      )}
    </span>
  );
}

// A span, not a button: these sit inside buttons and options, so taps stop here rather than select them.
// A tap also pins the popover open, since touch has no hover.
function DisclosureIcon({ icon: Icon, text, size }: { icon: Icon; text: string; size: number }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const stop = (e: MouseEvent | PointerEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <Popover
      opened={hovered || pinned}
      onChange={(opened) => {
        if (!opened) {
          setPinned(false);
          setHovered(false);
        }
      }}
      width={260}
      position="top"
      withArrow
      shadow="md"
    >
      <Popover.Target>
        <span
          role="button"
          tabIndex={0}
          aria-label={text}
          className="inline-flex cursor-help items-center text-gray-6 dark:text-dark-2"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            setPinned(true);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            stop(e);
            setPinned(true);
          }}
        >
          <Icon size={size} stroke={1.75} />
        </span>
      </Popover.Target>
      <Popover.Dropdown onClick={stop} onPointerDown={stop}>
        <Text size="xs">{text}</Text>
      </Popover.Dropdown>
    </Popover>
  );
}
