// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as CommentsProvider from '~/components/CommentsV2/CommentsProvider';
import type * as UseCurrentUser from '~/hooks/useCurrentUser';
import {
  CommentProvider,
  useCommentV2Context,
} from '~/components/CommentsV2/Comment/CommentProvider';
import { ImageProvider, useImageContext } from '~/components/Image/ImageProvider';
import { isViewingOwnImages } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { isViewer } from '~/utils/is-viewer';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = { id: 7, isModerator: false };
let currentUser: { id: number; isModerator: boolean } | null = null;

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof UseCurrentUser>()),
  useCurrentUser: () => currentUser,
}));
vi.mock('~/components/CommentsV2/CommentsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsProvider>()),
  useCommentsContext: () => ({ isLocked: false, isMuted: false, forceLocked: false, badges: [] }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelContext: () => ({ blurLevels: nsfwBrowsingLevelsFlag }),
}));

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  currentUser = null;
});

function render(element: React.ReactElement) {
  const root = createRoot(document.createElement('div'), {
    onUncaughtError: (error) => {
      throw error;
    },
  });
  roots.push(root);
  act(() => root.render(React.createElement(MantineProvider, null, element)));
}

describe('isViewer', () => {
  it.each([
    ['signed out, no owner id', null, undefined, false],
    ['signed out, null owner id', null, null, false],
    ['signed out, owned row', null, 7, false],
    ['signed in, no owner id', OWNER, undefined, false],
    ['signed in, someone else', OWNER, 8, false],
    ['signed in, own row', OWNER, 7, true],
  ] as const)('%s', (_, viewer, userId, expected) => {
    expect(isViewer(viewer, userId)).toBe(expected);
  });
});

// Each surface below compared `<owner id> === currentUser?.id` before, which a signed-out viewer
// and a missing owner id satisfy.
describe('a signed-out viewer is not the owner of an entity missing its owner id', () => {
  function imageIsOwner(image: { id: number; userId?: number; user?: { id?: number } }) {
    let isOwner: boolean | undefined;
    const Probe = () => {
      isOwner = useImageContext().isOwner;
      return null;
    };
    render(React.createElement(ImageProvider, image as never, React.createElement(Probe)));
    return isOwner;
  }

  it('image context menu: an image carrying only `userId`, or only `user`', () => {
    expect(imageIsOwner({ id: 1, userId: OWNER.id })).toBe(false);
    expect(imageIsOwner({ id: 1, user: { id: OWNER.id } })).toBe(false);
    currentUser = OWNER;
    expect(imageIsOwner({ id: 1, userId: OWNER.id })).toBe(true);
    expect(imageIsOwner({ id: 1, user: { id: OWNER.id } })).toBe(true);
  });

  function commentControls(resourceOwnerId?: number) {
    let ctx: { canHide?: boolean; canPin?: boolean } = {};
    const Probe = () => {
      ctx = useCommentV2Context();
      return null;
    };
    const comment = { id: 1, user: { id: 99 }, hidden: false } as never;
    render(
      React.createElement(
        CommentProvider,
        { comment, resourceOwnerId } as never,
        React.createElement(Probe)
      )
    );
    return { canHide: ctx.canHide, canPin: ctx.canPin };
  }

  it('comment hide/pin: a thread rendered without a resource owner', () => {
    expect(commentControls()).toEqual({ canHide: false, canPin: false });
    currentUser = OWNER;
    expect(commentControls(OWNER.id)).toEqual({ canHide: true, canPin: true });
  });

  function guardShows(image: { id: number; nsfwLevel: number; userId?: number }) {
    let shown: boolean | undefined;
    render(
      React.createElement(ImageGuard2, { image, explain: false } as never, (show: boolean) => {
        // `show` is `undefined`, not `false`, when the guard blurs.
        shown = Boolean(show);
        return null;
      })
    );
    return shown;
  }

  it('image guard: an unrated image with no owner id stays blurred', () => {
    expect(guardShows({ id: 2, nsfwLevel: 0 })).toBe(false);
    currentUser = OWNER;
    expect(guardShows({ id: 3, nsfwLevel: 0, userId: OWNER.id })).toBe(true);
  });
});

describe('own-images feed: excluded tags are dropped only for the signed-in owner', () => {
  it.each([
    ['signed out, no user filter', null, {}, false],
    ['signed out, filtered to a user', null, { userId: 7 }, false],
    ['signed out, filtered to a username', null, { username: 'me' }, false],
    ['signed in, someone else', { id: 7, username: 'me' }, { userId: 8, username: 'you' }, false],
    ['signed in, own id', { id: 7, username: 'me' }, { userId: 7 }, true],
    [
      'signed in, own username in another case',
      { id: 7, username: 'me' },
      { username: 'ME' },
      true,
    ],
  ] as const)('%s', (_, viewer, filters, expected) => {
    expect(isViewingOwnImages(viewer, filters)).toBe(expected);
  });
});

// These sites sit inside page-sized components with no harness here, so each is pinned on source:
// the removed expression stays gone and the isViewer call is present. A text pin cannot see the
// value in use, so it catches a revert or a deleted check, not every way to get the owner wrong.
describe('sites without a behavioural case: the removed comparison stays removed', () => {
  it.each([
    [
      'src/components/Image/image.utils.ts',
      'filters.userId === currentUser',
      'const isOwnImages = isViewingOwnImages(currentUser, filters);',
    ],
    [
      'src/components/Collections/Collection.tsx',
      'currentUser?.id === (image.userId ?? image.user?.id)',
      'isViewer(currentUser, image.userId ?? image.user?.id)',
    ],
    [
      'src/components/Collections/Collection.tsx',
      'currentUser?.id === image.collectionItemAddedById',
      'isViewer(currentUser, image.collectionItemAddedById)',
    ],
    [
      'src/components/Bounty/BountyContextMenu.tsx',
      'currentUser?.id === bounty.user?.id',
      'isOwner = isViewer(currentUser, bounty.user?.id)',
    ],
    [
      'src/pages/bounties/[id]/[[...slug]].tsx',
      'currentUser?.id === bounty?.user?.id',
      'isViewer(currentUser, bounty?.user?.id)',
    ],
    [
      'src/pages/articles/[id]/[[...slug]].tsx',
      'currentUser?.id === article?.user?.id',
      'isActualOwner = isViewer(currentUser, article?.user?.id)',
    ],
  ])('%s: %s', (file, unguarded, guarded) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toContain(unguarded);
    expect(source).toContain(guarded);
  });
});
