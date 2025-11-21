import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { AdUnitOutstreamWithCloseButton } from '~/components/Ads/AdUnitOutstream';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';

const ChatWindow = dynamic(() => import('~/components/Chat/ChatWindow').then((m) => m.ChatWindow));

export function ChatPortal({ showFooter }: { showFooter: boolean }) {
  const open = useChatStore((state) => state.open);
  const isMobile = useIsMobile();
  const isClient = useIsClient();

  // if (!state.open) return null;

  if (!open)
    return isClient && !isMobile ? (
      <div className="absolute bottom-[var(--footer-height)] left-2 mb-2">
        <AdUnitOutstreamWithCloseButton />
      </div>
    ) : null;

  return (
    <div
      className={clsx(
        'absolute bottom-0 left-0 z-[251] mb-2 ml-2 h-dvh w-[calc(100%-1rem)]',
        '@sm:h-[800px] @sm:w-[70%] @sm:max-w-[700px]'
      )}
      style={{
        maxHeight: `calc(100dvh - var(--header-height)${
          showFooter ? ' - var(--footer-height)' : ''
        } - 1rem)`,
      }}
    >
      <ChatWindow />
    </div>
  );
}
