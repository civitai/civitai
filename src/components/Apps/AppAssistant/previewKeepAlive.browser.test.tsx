import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { isPaneShown, usePreviewKeepAlive } from '~/components/Apps/AppAssistant/previewKeepAlive';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/** A frame like the preview's (scripts only, opaque origin) that posts `type` to the page on load. */
const posting = (type: string) =>
  `<script>parent.postMessage({ type: ${JSON.stringify(type)}, requestId: 'r1' }, '*')</script>`;

function Pane({
  ping,
  hidden = false,
  frame,
}: {
  ping: (() => Promise<unknown>) | null;
  hidden?: boolean;
  frame?: string;
}) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  usePreviewKeepAlive(pane, ping);
  return (
    <div>
      <button type="button">outside</button>
      <div
        ref={setPane}
        data-testid="pane"
        style={{ display: hidden ? 'none' : 'block', width: 320, height: 240 }}
      >
        <button type="button">pane button</button>
        {frame !== undefined && <iframe title="app" sandbox="allow-scripts" srcDoc={frame} />}
      </div>
    </div>
  );
}

const pane = () => document.querySelector<HTMLElement>('[data-testid="pane"]')!;
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** Messages from the preview's frame that reached the page, whatever the hook made of them. */
function frameMessages() {
  const seen: string[] = [];
  const listen = (e: MessageEvent) => {
    const frame = document.querySelector('iframe');
    if (frame && e.source === frame.contentWindow) seen.push((e.data as { type: string }).type);
  };
  window.addEventListener('message', listen);
  return { seen, stop: () => window.removeEventListener('message', listen) };
}

afterEach(() => {
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('usePreviewKeepAlive', () => {
  test('pointer, key and wheel in the shown pane ping, once for a burst', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    renderWithProviders(<Pane ping={ping} />);
    await expect.element(page.getByTestId('pane')).toBeInTheDocument();
    expect(ping).not.toHaveBeenCalled();

    pane().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    pane().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    pane().dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('focus moving into the pane pings', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    renderWithProviders(<Pane ping={ping} />);
    await expect.element(page.getByTestId('pane')).toBeInTheDocument();
    // Focus alone, no pointer: what a click into the app's frame leaves the page to see.
    pane().querySelector('button')!.focus();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('NEGATIVE CONTROL: activity outside the pane does not ping', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    renderWithProviders(<Pane ping={ping} />);
    await page.getByRole('button', { name: 'outside' }).click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle(50);
    expect(ping).not.toHaveBeenCalled();
  });

  test('NEGATIVE CONTROL: the pointer only moving over the pane does not ping', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    renderWithProviders(<Pane ping={ping} />);
    await expect.element(page.getByTestId('pane')).toBeInTheDocument();
    pane().dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    pane().dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    expect(ping).not.toHaveBeenCalled();
    // Positive control: a press on the same pane does.
    pane().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('a request the app makes for its viewer over the bridge pings', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    const msgs = frameMessages();
    renderWithProviders(<Pane ping={ping} frame={posting('SUBMIT_WORKFLOW')} />);
    await vi.waitFor(() => expect(msgs.seen).toEqual(['SUBMIT_WORKFLOW']));
    expect(ping).toHaveBeenCalledTimes(1);
    msgs.stop();
  });

  test('the SDK reporting input inside the app frame (VIEWER_ACTIVITY) pings', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    const msgs = frameMessages();
    renderWithProviders(<Pane ping={ping} frame={posting('VIEWER_ACTIVITY')} />);
    await vi.waitFor(() => expect(msgs.seen).toEqual(['VIEWER_ACTIVITY']));
    expect(ping).toHaveBeenCalledTimes(1);
    msgs.stop();
  });

  test('NEGATIVE CONTROL: a message the app sends by itself does not ping', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    const msgs = frameMessages();
    renderWithProviders(<Pane ping={ping} frame={posting('RESIZE_IFRAME')} />);
    // It did reach the page.
    await vi.waitFor(() => expect(msgs.seen).toEqual(['RESIZE_IFRAME']));
    await settle(50);
    expect(ping).not.toHaveBeenCalled();
    msgs.stop();
  });

  test('NEGATIVE CONTROL: the same request from another window does not ping', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    let arrived = 0;
    const listen = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'SUBMIT_WORKFLOW') arrived++;
    };
    window.addEventListener('message', listen);
    renderWithProviders(<Pane ping={ping} frame="" />);
    await expect.element(page.getByTestId('pane')).toBeInTheDocument();
    window.postMessage({ type: 'SUBMIT_WORKFLOW', requestId: 'r1' }, '*');
    await vi.waitFor(() => expect(arrived).toBe(1));
    await settle(50);
    expect(ping).not.toHaveBeenCalled();
    window.removeEventListener('message', listen);
  });

  test('nothing while the pane is not shown (display: none)', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    renderWithProviders(<Pane ping={ping} hidden frame={posting('SUBMIT_WORKFLOW')} />);
    await expect.element(page.getByTestId('pane')).toBeInTheDocument();
    expect(isPaneShown(pane())).toBe(false);
    pane().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(ping).not.toHaveBeenCalled();
  });

  test('nothing while the tab is hidden; the next activity once it is visible pings', async () => {
    const ping = vi.fn().mockResolvedValue(true);
    renderWithProviders(<Pane ping={ping} />);
    await expect.element(page.getByTestId('pane')).toBeInTheDocument();

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    expect(isPaneShown(pane())).toBe(false);
    pane().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(ping).not.toHaveBeenCalled();

    delete (document as { visibilityState?: unknown }).visibilityState;
    expect(isPaneShown(pane())).toBe(true);
    pane().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
