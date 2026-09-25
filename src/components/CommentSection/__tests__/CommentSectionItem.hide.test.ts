// @vitest-environment happy-dom
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TrpcModule from '~/utils/trpc';

const MODEL_OWNER_ID = 100;
const REPLY_AUTHOR_ID = 200;
const STRANGER_ID = 300;

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; isModerator?: boolean; muted?: boolean },
  toggleHide: vi.fn(),
  invalidateThread: vi.fn(),
  model: undefined as undefined | { user: { id: number } },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: {
      useUtils: () => ({
        comment: { getCommentsById: { invalidate: mocks.invalidateThread } },
      }),
      comment: {
        getReactions: { useQuery: () => ({ data: [] }) },
        upsert: { useMutation: mutation },
        delete: { useMutation: mutation },
        toggleReaction: { useMutation: mutation },
        toggleHide: {
          useMutation: (opts?: { onSuccess?: () => unknown }) => ({
            mutate: (vars: unknown) => {
              mocks.toggleHide(vars);
              void opts?.onSuccess?.();
            },
            isPending: false,
          }),
        },
      },
      model: {
        getById: { useQuery: () => ({ data: mocks.model }) },
      },
    },
  };
});

// Leaf renderers stubbed to plain text so the assertions read what reaches the DOM,
// including the author's name, without pulling in the editor and cosmetics graphs.
vi.mock('~/components/RichTextEditor/RichTextEditor', () => ({
  RichTextEditor: () => createElement('span', null, 'editor-open'),
}));
vi.mock('~/components/Sticker/StickerPicker', () => ({ StickerPicker: () => null }));
vi.mock('~/components/ReactionPicker/ReactionPicker', () => ({
  ReactionPicker: () => createElement('span', null, 'reactions'),
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => createElement('div', null, html),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) =>
    createElement('span', null, `avatar:${user.username}`),
}));
vi.mock('~/components/UserAvatar/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('~/components/User/Username', () => ({
  Username: ({ username }: { username: string }) => createElement('span', null, username),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: vi.fn() }));
vi.mock('~/components/Dates/DaysFromNow', () => ({ DaysFromNow: () => null }));

import { MantineProvider } from '@mantine/core';

import { CommentSectionItem } from '~/components/CommentSection/CommentSectionItem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPLY_TEXT = 'reply body text';
const AUTHOR_NAME = 'replyauthor';

function reply(hidden: boolean) {
  return {
    id: 5,
    parentId: 1,
    modelId: 9,
    hidden,
    locked: false,
    content: REPLY_TEXT,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    reactions: [],
    user: { id: REPLY_AUTHOR_ID, username: AUTHOR_NAME, deletedAt: null },
  } as unknown as Parameters<typeof CommentSectionItem>[0]['comment'];
}

let root: ReturnType<typeof createRoot> | null = null;

function render(hidden: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light', env: 'test' },
        createElement(CommentSectionItem, {
          comment: reply(hidden),
          modelId: 9,
          onReplyClick: () => undefined,
        })
      )
    );
  });
}

function text() {
  return document.body.textContent ?? '';
}

function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no button "${label}" in: ${text()}`);
  act(() => button.click());
}

function openMenu() {
  const target = document.querySelector('button.mantine-ActionIcon-root, [aria-haspopup]');
  if (!target) throw new Error('menu target not found');
  act(() => (target as HTMLElement).click());
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  mocks.model = { user: { id: MODEL_OWNER_ID } };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('CommentSectionItem: hiding a reply in the model comment thread', () => {
  it('offers Hide to the model owner and sends the reply id', () => {
    mocks.currentUser = { id: MODEL_OWNER_ID };
    render(false);

    expect(openMenu()).toContain('Hide comment');
    act(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((el) => el.textContent?.trim() === 'Hide comment')
        ?.click()
    );
    expect(mocks.toggleHide).toHaveBeenCalledWith({ id: 5 });
    expect(mocks.invalidateThread).toHaveBeenCalledTimes(1);
  });

  it('does not offer Hide to a logged-out viewer while the model is still loading', () => {
    mocks.currentUser = null;
    mocks.model = undefined;
    render(false);

    const items = openMenu();
    expect(items).toContain('Report');
    expect(items).not.toContain('Hide comment');
  });

  it('opens the editor when the author edits their own hidden reply', () => {
    mocks.currentUser = { id: REPLY_AUTHOR_ID };
    render(true);
    expect(text()).toContain('Hidden comment');

    openMenu();
    act(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((el) => el.textContent?.trim() === 'Edit comment')
        ?.click()
    );
    expect(text()).toContain('editor-open');
    expect(text()).not.toContain('Hidden comment');
  });

  it('offers Hide to a moderator', () => {
    mocks.currentUser = { id: STRANGER_ID, isModerator: true };
    render(false);

    expect(openMenu()).toContain('Hide comment');
  });

  it("does not offer Hide to the reply's author or to a stranger", () => {
    mocks.currentUser = { id: REPLY_AUTHOR_ID };
    render(false);
    const authorItems = openMenu();
    expect(authorItems).not.toContain('Hide comment');
    expect(authorItems).toContain('Delete comment');

    act(() => root?.unmount());
    document.body.innerHTML = '';
    mocks.currentUser = { id: STRANGER_ID };
    render(false);
    const strangerItems = openMenu();
    expect(strangerItems).not.toContain('Hide comment');
    expect(strangerItems).toContain('Report');
  });

  it('offers Unhide on a hidden reply to the model owner', () => {
    mocks.currentUser = { id: MODEL_OWNER_ID };
    render(true);

    expect(openMenu()).toContain('Unhide comment');
  });

  it('shows a hidden reply to any viewer as "Hidden comment", withholding author and body', () => {
    mocks.currentUser = { id: STRANGER_ID };
    render(true);

    expect(text()).toContain('Hidden comment');
    expect(text()).not.toContain(AUTHOR_NAME);
    expect(text()).not.toContain(REPLY_TEXT);
    expect(text()).not.toContain('reactions');

    clickButton('Show');
    expect(text()).toContain(AUTHOR_NAME);
    expect(text()).toContain(REPLY_TEXT);
    expect(text()).not.toContain('Hidden comment');

    clickButton('Hide again');
    expect(text()).toContain('Hidden comment');
    expect(text()).not.toContain(REPLY_TEXT);
  });

  it('renders a visible reply normally, with no placeholder', () => {
    mocks.currentUser = null;
    render(false);

    expect(text()).toContain(AUTHOR_NAME);
    expect(text()).toContain(REPLY_TEXT);
    expect(text()).not.toContain('Hidden comment');
    expect(text()).not.toContain('Hide again');
  });
});
