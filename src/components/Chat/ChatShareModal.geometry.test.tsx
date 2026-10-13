/**
 * Send Chat modal at a SHORT viewport with a LONG chat list.
 *
 * The modal body is a flex column capped at the viewport so the chat list is the only
 * scroller. Every other child must keep its content height: with the default
 * `flex-shrink: 1` they shrank alongside the list, and the Send button (Mantine sets
 * `overflow: hidden` on it, so its automatic minimum height is 0) was squashed to ~10px
 * with its icon and label clipped.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  box,
  cascadeEvidence,
  renderAtViewport,
  type Viewport,
} from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';

const ME = 1;

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'me', isModerator: false }),
}));
// The avatar pulls in feature flags and image loading; a fixed box keeps each row's height.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => <div style={{ width: 32, height: 32 }} />,
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));

const chats = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  createdAt: new Date(2026, 0, 1, 0, i),
  messages: [{ content: `last message ${i}`, contentType: 'Markdown', createdAt: new Date() }],
  chatMembers: [
    { userId: ME, status: 'Joined', isOwner: false, user: { id: ME, username: 'me' } },
    {
      userId: 100 + i,
      status: 'Joined',
      isOwner: false,
      user: { id: 100 + i, username: `user${i}`, isModerator: false },
    },
  ],
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'chat.getAllByUser': { useQuery: () => ({ data: chats, isLoading: false }) },
  }),
}));

const { default: ChatShareModal } = await import('./ChatShareModal');

// A custom property reads back unresolved (`var(--button-height-sm)`); lay it out to get pixels.
function resolvedLength(value: string) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;height:${value}`;
  document.body.append(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

const SHORT: Viewport[] = [
  { width: 390, height: 600 },
  { width: 1280, height: 600 },
];

describe('ChatShareModal at a short viewport with a long list', () => {
  test.each(SHORT)(
    'Send keeps its full height and stays on screen at $width x $height',
    async (vp) => {
      await renderAtViewport(<ChatShareModal message="https://civitai.com/models/1" />, vp);
      expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(
        true
      );

      const send = await vi.waitUntil(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
          (b) => b.textContent?.trim() === 'Send'
        )
      );
      const list = send.parentElement?.querySelector<HTMLElement>('.overflow-y-auto');
      if (!list) throw new Error('chat list scroller did not render');

      // Wait out the modal's open transition before measuring.
      await vi.waitUntil(
        () => getComputedStyle(send).opacity === '1' && document.getAnimations().length === 0,
        { timeout: 5000 }
      );

      // The list really is overflowing, or nothing below is under pressure.
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

      const label = send.querySelector('.mantine-Button-label');
      if (!label) throw new Error('Send label did not render');
      const declared = resolvedLength(getComputedStyle(send).getPropertyValue('--button-height'));
      expect(declared).toBeGreaterThan(0);
      const icon = send.querySelector('svg');
      if (!icon) throw new Error('Send icon did not render');
      expect(box(send).height).toBeGreaterThanOrEqual(box(icon).height);
      expect(box(send).height).toBeGreaterThanOrEqual(declared);
      expect(box(send).height).toBeGreaterThanOrEqual(box(label).height);
      expect(box(send).bottom).toBeLessThanOrEqual(vp.height);
    }
  );
});
