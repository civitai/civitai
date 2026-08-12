import { Menu, Text } from '@mantine/core';
import { IconBrush, IconMovie, IconWand } from '@tabler/icons-react';
import type { RemixKind } from '~/shared/constants/remix.constants';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import {
  canReusePrompt,
  getRemixKinds,
  getRemixRefusal,
  startPromptReuse,
  startRemix,
  type RemixSourceImage,
} from '~/components/Image/Remix/remix.utils';

const kindLabels: Record<RemixKind, { label: string; description: string; icon: typeof IconWand }> =
  {
    edit: { label: 'Edit image', description: 'Change this image with a prompt', icon: IconWand },
    video: { label: 'Animate', description: 'Turn this image into a video', icon: IconMovie },
  };

/** Whether the button has anything to offer. Not a hook — callable after an early return. */
export function isRemixMenuVisible(image: RemixSourceImage) {
  return getRemixKinds(image).length > 0 || canReusePrompt(image);
}

export function RemixMenu({
  image,
  source,
  onAction,
  children,
  zIndex,
}: {
  image: RemixSourceImage;
  /** Entry-point tag for telemetry, e.g. `remix:image-card`. */
  source: string;
  onAction?: () => void;
  children: React.ReactNode;
  zIndex?: number;
}) {
  const { trackAction } = useTrackEvent();
  const kinds = getRemixKinds(image);
  const refusal = getRemixRefusal(image);
  const showReuse = canReusePrompt(image);

  const track = (suffix: string) =>
    trackAction({
      type: 'Image_Remix_Click',
      details: { imageId: image.id, imageType: image.type, source: `${source}:${suffix}` },
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

  return (
    <Menu withinPortal position="bottom-end" zIndex={zIndex}>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown
        onClick={(e) => {
          // These live inside RoutedDialogLink on the feed cards, which would
          // otherwise navigate to the image detail behind the menu.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {refusal ? (
          <Menu.Item disabled>
            <Text size="xs">{refusal}</Text>
          </Menu.Item>
        ) : (
          <>
            {kinds.map((kind) => {
              const { label, description, icon: Icon } = kindLabels[kind];
              return (
                <Menu.Item
                  key={kind}
                  leftSection={<Icon size={16} stroke={1.5} />}
                  onClick={() => handleKind(kind)}
                >
                  <Text size="sm">{label}</Text>
                  <Text size="xs" c="dimmed">
                    {description}
                  </Text>
                </Menu.Item>
              );
            })}
            {kinds.length > 0 && showReuse && <Menu.Divider />}
            {showReuse && (
              <Menu.Item leftSection={<IconBrush size={16} stroke={1.5} />} onClick={handleReuse}>
                <Text size="sm">Reuse prompt &amp; resources</Text>
                <Text size="xs" c="dimmed">
                  Start from this image&apos;s settings
                </Text>
              </Menu.Item>
            )}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
