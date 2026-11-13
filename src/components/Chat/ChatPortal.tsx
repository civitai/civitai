import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { AdUnitOutstreamWithCloseButton } from '~/components/Ads/AdUnitOutstream';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';

const ChatWindow = dynamic(() => import('~/components/Chat/ChatWindow').then((m) => m.ChatWindow));

/** `?chat=<id>` opens that conversation, so a notification can link straight to a thread. */
function useOpenChatFromQuery() {
  const router = useRouter();
  const chatId = Number(router.query.chat);
  useEffect(() => {
    if (!router.isReady || !Number.isInteger(chatId) || chatId <= 0) return;
    useChatStore.setState({ open: true, isCreating: false, existingChatId: chatId });
    const { chat: _, ...query } = router.query;
    router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  }, [router, chatId]);
}

export function ChatPortal({ showFooter }: { showFooter: boolean }) {
  useOpenChatFromQuery();
  const open = useChatStore((state) => state.open);
  const isMobile = useIsMobile();
  const isClient = useIsClient();

  // if (!state.open) return null;

  if (!open)
    return isClient && !isMobile ? (
      // Same idiom, same correction, same reason as `AppFooter`'s floating
      // cluster: `bottom: var(--footer-height)` is an offset chosen to clear
      // the footer BAR, and the bar is now `--footer-height` plus whatever
      // inset it pays. Left at 45px it lands inside the bar. `…-unpaid`
      // rather than the raw inset so the two agree in both arms — when
      // `AdhesiveAd` is below, the bar pays nothing and this stays put.
      //
      // Reached only on `!isMobile`, which is exactly where this was easy to
      // miss: a Face-ID iPad is not "mobile" here and does have insets.
      <div className="absolute bottom-[calc(var(--footer-height)+var(--safe-area-inset-bottom-unpaid))] left-2 mb-2">
        <AdUnitOutstreamWithCloseButton />
      </div>
    ) : null;

  return (
    <div
      className={clsx(
        'absolute bottom-0 left-0 z-[251] h-dvh w-full',
        // A phone gets a sheet, like the notifications drawer: edge to edge, from the header down to
        // the screen's bottom, with the bottom inset paid inside the window (on its own background)
        // so the composer clears the home indicator.
        'max-h-[var(--chat-max-h)] @max-sm:[&>*]:rounded-none @max-sm:[&>*]:pb-[var(--safe-area-inset-bottom)]',
        // From `@sm` up it floats. The composer is the bottom-most control, so the margin is what
        // keeps someone from typing under the home indicator.
        '@sm:mb-[max(0.5rem,var(--safe-area-inset-bottom))] @sm:ml-2 @sm:h-[800px] @sm:w-[70%] @sm:max-w-[700px]',
        '@sm:max-h-[calc(var(--chat-max-h)-var(--safe-area-inset-bottom)-1rem)]'
      )}
      // `100dvh` grew by the insets when the layout viewport started covering the cutout, so the cap
      // subtracts the top one back or the window rides up under the header.
      style={
        {
          '--chat-max-h': `calc(100dvh - var(--safe-area-inset-top) - var(--header-height)${
            showFooter ? ' - var(--footer-height)' : ''
          })`,
        } as React.CSSProperties
      }
    >
      <ChatWindow />
    </div>
  );
}
