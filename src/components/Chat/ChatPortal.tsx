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
        // The composer input is the bottom-most control in the window, so the 8px
        // `mb-2` is what would leave someone typing under the home indicator.
        'absolute bottom-0 left-0 z-[251] mb-[max(0.5rem,var(--safe-area-inset-bottom))] ml-2 h-dvh w-[calc(100%-1rem)]',
        '@sm:h-[800px] @sm:w-[70%] @sm:max-w-[700px]'
      )}
      // `100dvh` grew by (top inset + bottom inset) when the layout viewport
      // started covering the cutout, so this cap has to subtract them back or the
      // window is taller than it was and rides up under the header.
      style={{
        maxHeight: `calc(100dvh - var(--safe-area-inset-top) - var(--safe-area-inset-bottom) - var(--header-height)${
          showFooter ? ' - var(--footer-height)' : ''
        } - 1rem)`,
      }}
    >
      <ChatWindow />
    </div>
  );
}
