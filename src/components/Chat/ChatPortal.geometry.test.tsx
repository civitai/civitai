/**
 * The open chat window on a phone spans the screen edge to edge, like the notifications drawer,
 * instead of floating 8px in from each side with rounded corners. Desktop keeps its floating
 * 70% / 700px window.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  box,
  cascadeEvidence,
  renderAtViewport,
  PHONE_VIEWPORT,
} from '../../../test/geometry-setup';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { ChatPortal } from '~/components/Chat/ChatPortal';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
// globals.css declares `--header-height` from this; the test reads that one declaration.
import { HEADER_HEIGHT_PX } from '~/shared/constants/app-layout.constants';

vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: false, query: {}, pathname: '/', replace: () => undefined }),
}));
// The real window loads the whole chat app; a stand-in with its root's classes (ChatWindow.tsx)
// keeps the corners the real one gets, and ends in a composer like the real one.
vi.mock('~/components/Chat/ChatWindow', async () => {
  const { default: classes } = await import('~/components/Chat/Chat.module.scss');
  return {
    ChatWindow: () => (
      <div data-chat-window className={`size-full card ${classes.surface}`}>
        <div className="flex-1" />
        <div data-composer style={{ height: 40 }} />
      </div>
    ),
  };
});

// A notched phone's insets, which the harness otherwise reports as 0.
const INSET_TOP = 20;
const INSET_BOTTOM = 34;

// `@sm:` is a container query against BaseLayout's ContainerProvider, as in the app.
const ui = (
  <div
    style={
      {
        width: '100vw',
        height: '100vh',
        '--safe-area-inset-top': `${INSET_TOP}px`,
        '--safe-area-inset-bottom': `${INSET_BOTTOM}px`,
      } as React.CSSProperties
    }
  >
    <ContainerProvider containerName="main">
      <ChatPortal showFooter={false} />
    </ContainerProvider>
  </div>
);

async function renderOpen(vp: { width: number; height: number }) {
  useChatStore.setState({ open: true });
  await renderAtViewport(ui, vp);
  expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(true);
  const win = await vi.waitUntil(() => document.querySelector('[data-chat-window]'), {
    timeout: 5_000,
  });
  return { win, frame: win.parentElement! };
}

describe('ChatPortal open window', () => {
  test('is a sheet on a 390px phone: edge to edge, header to screen bottom', async () => {
    const { win, frame } = await renderOpen(PHONE_VIEWPORT);
    const b = box(frame);

    expect(b.left).toBe(0);
    expect(b.width).toBe(PHONE_VIEWPORT.width);
    expect(getComputedStyle(win).borderTopLeftRadius).toBe('0px');
    expect(b.bottom, 'flush with the screen bottom').toBe(PHONE_VIEWPORT.height);
    expect(b.top, 'meets the header').toBe(INSET_TOP + HEADER_HEIGHT_PX);
    const composer = box(win.querySelector('[data-composer]')!);
    expect(composer.bottom, 'composer clears the home indicator').toBeLessThanOrEqual(
      PHONE_VIEWPORT.height - INSET_BOTTOM
    );
  });

  test('keeps the floating 700px window on desktop', async () => {
    const { win, frame } = await renderOpen({ width: 1280, height: 900 });
    const b = box(frame);

    expect(b.left).toBe(8);
    expect(b.width).toBe(700);
    expect(getComputedStyle(win).borderTopLeftRadius).not.toBe('0px');
    // Unchanged: lifted by the bottom inset, capped 1rem short of the header.
    expect(b.bottom).toBe(900 - INSET_BOTTOM);
    expect(b.height).toBe(900 - INSET_TOP - INSET_BOTTOM - HEADER_HEIGHT_PX - 16);
  });
});
