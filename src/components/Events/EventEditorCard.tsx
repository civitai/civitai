import type { ButtonProps } from '@mantine/core';
import { Button, CloseButton, Text } from '@mantine/core';
import { IconConfetti } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { EditorSurface } from '~/components/Events/event-promos';
import { editorCardId, editorPromo } from '~/components/Events/event-promos';
import { useEventPromos } from '~/components/Events/useEventPromos';
import { NextLink } from '~/components/NextLink/NextLink';

/**
 * The playable event's card in an editor's sidebar. Its copy comes from the event's promo for that
 * editor, so it shows only to viewers who can play; `children` is what the card offers to do.
 */
export function EventEditorCard({
  surface,
  showDraftNote,
  children,
  'data-testid': testId,
}: {
  surface: EditorSurface;
  showDraftNote: boolean;
  children: (event: string) => ReactNode;
  'data-testid': string;
}) {
  const { dismissed, dismiss } = useNavBannersDismissed();
  const promo = editorPromo(useEventPromos(), dismissed, surface);
  const copy = promo?.[surface];
  if (!promo || !copy) return null;

  const { title, body, draftNote, image } = copy;

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-solid border-[#3b3566] bg-[#1c1a30] text-white"
      data-testid={testId}
    >
      <div className="relative h-[74px] overflow-hidden">
        {image && (
          <EdgeImage
            src={image}
            options={{ width: 320 }}
            alt=""
            className="absolute right-0 top-1/2 h-[180%] w-auto max-w-none -translate-y-1/2 [mask-image:linear-gradient(to_right,transparent,black_45%)]"
          />
        )}
        <Text
          fw={800}
          size="sm"
          className="absolute left-3 top-3 [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]"
        >
          {title}
        </Text>
        <CloseButton
          size="sm"
          variant="transparent"
          aria-label={`Hide ${title}`}
          className="absolute right-1 top-1 text-white/70 hover:text-white"
          onClick={() => dismiss(editorCardId(surface, promo.event))}
        />
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
        <Text size="xs" c="gray.4">
          {body}
        </Text>
        {children(promo.event)}
        {showDraftNote && draftNote && (
          <Text size="xs" c="yellow.4">
            {draftNote}
          </Text>
        )}
        <NextLink
          href={promo.teamHref ?? `/events/${promo.event}`}
          className="text-center text-xs text-blue-3"
        >
          Team standings →
        </NextLink>
      </div>
    </div>
  );
}

export function EventHatButton(props: ButtonProps & { onClick: () => void }) {
  return (
    <Button
      fullWidth
      variant="gradient"
      gradient={{ from: 'yellow.5', to: 'pink.5', deg: 90 }}
      c="dark.9"
      leftSection={<IconConfetti size={16} />}
      {...props}
    />
  );
}
