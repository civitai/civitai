import { Menu, Text, ThemeIcon } from '@mantine/core';
import { useRef } from 'react';
import { IconBrush, IconMovie, IconWand } from '@tabler/icons-react';
import type { RemixKind } from '~/shared/constants/remix.constants';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import {
  canReusePrompt,
  getEngineRefusal,
  getRemixKinds,
  isReuseRefused,
  startPromptReuse,
  startRemix,
  type RemixSourceImage,
} from '~/components/Image/Remix/remix.utils';
import { remixMenuZIndex } from '~/shared/constants/app-layout.constants';

type RemixOption = {
  label: string;
  description: string;
  icon: typeof IconWand;
  /** A colour per option so the three read as distinct things, not a list. */
  color: string;
};

const kindLabels: Record<RemixKind, RemixOption> = {
  edit: {
    label: 'Edit image',
    description: 'Change this image with a prompt',
    icon: IconWand,
    color: 'violet',
  },
  video: {
    label: 'Animate',
    description: 'Turn this image into a video',
    icon: IconMovie,
    color: 'blue',
  },
};

const reuseOption: RemixOption = {
  label: 'Reuse prompt & resources',
  description: "Start from this image's settings",
  icon: IconBrush,
  color: 'teal',
};

function OptionIcon({ option }: { option: RemixOption }) {
  return (
    <ThemeIcon size={36} radius="md" variant="light" color={option.color}>
      <option.icon size={20} stroke={1.7} />
    </ThemeIcon>
  );
}

function OptionLabel({ option }: { option: RemixOption }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Text size="sm" fw={600} lh={1.2}>
        {option.label}
      </Text>
      <Text size="xs" c="dimmed" lh={1.2}>
        {option.description}
      </Text>
    </div>
  );
}

/** Whether the button has anything to offer. Not a hook — callable after an early return. */
export function isRemixMenuVisible(image: RemixSourceImage) {
  return getRemixKinds(image).length > 0 || canReusePrompt(image);
}

export function RemixMenu({
  image,
  source,
  sourceModelVersionId,
  onAction,
  children,
  zIndex,
}: {
  image: RemixSourceImage;
  /** Entry-point tag for telemetry, e.g. `remix:image-card`. */
  source: string;
  /** Known only where the surface is scoped to a version (the model carousel). */
  sourceModelVersionId?: number;
  onAction?: () => void;
  children: React.ReactNode;
  zIndex?: number;
}) {
  const { trackAction } = useTrackEvent();
  const kinds = getRemixKinds(image);
  const engineRefusal = getEngineRefusal(image);
  const showReuse = canReusePrompt(image) && !isReuseRefused(image);

  const track = (remixKind: 'edit' | 'video' | 'reuse') =>
    trackAction({
      type: 'Image_Remix_Click',
      details: {
        imageId: image.id,
        imageType: image.type,
        source,
        remixKind,
        sourceModelVersionId,
      },
    }).catch(() => undefined);

  const handleKind = (kind: RemixKind) => {
    track(kind);
    startRemix({ kind, image }).catch(() => undefined);
    onAction?.();
  };

  const handleReuse = () => {
    track('reuse');
    startPromptReuse(image).catch(() => undefined);
    onAction?.();
  };

  // A menu holding nothing but a disabled refusal has no item to click, so an
  // `onAction` that only fires from an item would strand a tour step whose only
  // way forward is clicking through this button. Latched because `onOpen` fires
  // on every open, and `onAction` advances a tour a step at a time.
  const hasActionableItem = (!engineRefusal && kinds.length > 0) || showReuse;
  const announcedRefusal = useRef(false);
  const handleRefusalOpen = () => {
    if (announcedRefusal.current) return;
    announcedRefusal.current = true;
    onAction?.();
  };

  return (
    <Menu
      withinPortal
      position="bottom-end"
      zIndex={zIndex ?? remixMenuZIndex}
      onOpen={hasActionableItem ? undefined : handleRefusalOpen}
    >
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown
        className="w-[290px] p-1.5"
        onClick={(e) => {
          // These live inside RoutedDialogLink on the feed cards, which would
          // otherwise navigate to the image detail behind the menu.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {engineRefusal && (
          <Menu.Item disabled>
            <Text size="xs">{engineRefusal}</Text>
          </Menu.Item>
        )}
        {!engineRefusal && (
          <>
            {kinds.map((kind) => {
              const option = kindLabels[kind];
              return (
                <Menu.Item
                  key={kind}
                  className="rounded-md px-2 py-2.5"
                  leftSection={<OptionIcon option={option} />}
                  onClick={() => handleKind(kind)}
                >
                  <OptionLabel option={option} />
                </Menu.Item>
              );
            })}
          </>
        )}
        {showReuse && (
          <Menu.Item
            className="rounded-md px-2 py-2.5"
            leftSection={<OptionIcon option={reuseOption} />}
            onClick={handleReuse}
          >
            <OptionLabel option={reuseOption} />
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
