// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { ThreadSort } from '~/server/common/enums';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 🔴 A NESTED THREAD INHERITS THE LOCK, ASSERTED IN THE `unit` PROJECT DELIBERATELY.
 *
 * A moderator locks one `Thread` row. A reply lives in a child thread of its own, and
 * `getThreadDetails` answers only about the thread it was asked for — so a nested provider's own
 * `locked` is false under a locked parent. The server resolves the whole chain and refuses the
 * write, so without this the UI offers Reply and Edit into a box that cannot accept them.
 *
 * This lives in a `.test.ts` because the `unit` project's include is `src/**\/*.test.ts` — `.tsx`
 * is excluded, and `*.browser.test.tsx` is a separate project that no CI job runs. A browser-only
 * assertion here would be reassurance, not a gate. Hence `React.createElement` rather than JSX.
 *
 * What is read is the value handed to the render child, which is the same object
 * `useCommentsContext()` returns — so this is what `CreateComment` and `CommentProvider` actually
 * gate on, not a reimplementation of it.
 */

const threadLocked = new Map<string, boolean>();

// Spread the real module and override only `trpc`: a hand-written factory couples this file to the
// module's whole export list, and the day one is added the file fails to LOAD and collects zero
// tests rather than failing an assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    commentv2: {
      getThreadDetails: {
        useQuery: ({ entityType, entityId }: { entityType: string; entityId: number }) => ({
          data: {
            id: entityId,
            locked: threadLocked.get(`${entityType}:${entityId}`) ?? false,
            hiddenCount: 0,
          },
        }),
      },
      getInfinite: {
        useInfiniteQuery: () => ({
          data: undefined,
          isLoading: false,
          isRefetching: false,
          fetchNextPage: () => undefined,
          hasNextPage: false,
          isFetchingNextPage: false,
        }),
      },
    },
  },
}));

vi.mock('next/router', () => ({ useRouter: () => ({ query: {} }) }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canWrite: true }),
}));

import { CommentsCtx, CommentsProvider, RootThreadCtx } from '../CommentsProvider';

const rootThreadValue = {
  sort: ThreadSort.Oldest,
  setSort: () => undefined,
  isInitialThread: false,
  setInitialThread: () => undefined,
  setRootThread: () => undefined,
  setExpanded: () => undefined,
  activeComment: undefined,
  rootEntityType: 'image' as const,
};

/**
 * The image thread, then a reply thread nested inside it. `capture` reads the inner provider's
 * value; the outer one renders its child so the inner actually mounts underneath it.
 */
function renderNested(capture: (isLocked: boolean) => void) {
  return React.createElement(
    RootThreadCtx.Provider,
    { value: rootThreadValue as never },
    React.createElement(CommentsProvider, {
      entityType: 'image',
      entityId: 1,
      level: 1,
      children: () =>
        React.createElement(CommentsProvider, {
          entityType: 'comment',
          entityId: 99,
          level: 2,
          children: ({ isLocked }: { isLocked: boolean }) => {
            capture(isLocked);
            return null;
          },
        } as never),
    } as never)
  );
}

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return () => act(async () => root.unmount());
}

beforeEach(() => {
  threadLocked.clear();
});

describe('a nested comment thread under a locked one', () => {
  it('reports LOCKED even though its own thread is not', async () => {
    threadLocked.set('image:1', true);
    // Stated rather than left to the default: the inner thread being unlocked is the whole point.
    threadLocked.set('comment:99', false);

    let inner: boolean | undefined;
    const unmount = await mount(renderNested((isLocked) => (inner = isLocked)));

    expect(inner, 'a reply thread under a locked thread must not offer to write').toBe(true);
    await unmount();
  });

  /**
   * The control. Without it the assertion above is satisfied by anything that reports `true`
   * unconditionally — including deleting the query and hardcoding a lock, which would close every
   * comment section on the site.
   */
  it('reports UNLOCKED when nothing above it is locked', async () => {
    threadLocked.set('image:1', false);
    threadLocked.set('comment:99', false);

    let inner: boolean | undefined;
    const unmount = await mount(renderNested((isLocked) => (inner = isLocked)));

    expect(inner, 'an ordinary reply thread must still be writable').toBe(false);
    await unmount();
  });

  it('still reports its OWN lock when the thread above it is open', async () => {
    threadLocked.set('image:1', false);
    threadLocked.set('comment:99', true);

    let inner: boolean | undefined;
    const unmount = await mount(renderNested((isLocked) => (inner = isLocked)));

    expect(inner).toBe(true);
    await unmount();
  });
});

describe('a top-level thread', () => {
  it('has no enclosing provider to inherit from and reads its own thread', async () => {
    threadLocked.set('image:1', true);

    let outer: boolean | undefined;
    const element = React.createElement(
      RootThreadCtx.Provider,
      { value: rootThreadValue as never },
      React.createElement(CommentsProvider, {
        entityType: 'image',
        entityId: 1,
        level: 1,
        children: ({ isLocked }: { isLocked: boolean }) => {
          outer = isLocked;
          return null;
        },
      } as never)
    );

    const unmount = await mount(element);
    // Reading the empty default context must not throw, and must not read as locked.
    expect(outer).toBe(true);
    await unmount();
  });
});

/** Guards the assumption the three tests above rest on: the context is what the children read. */
describe('the value the children read', () => {
  it('is the same object useCommentsContext returns', async () => {
    threadLocked.set('image:1', true);

    let fromChild: boolean | undefined;
    let fromContext: boolean | undefined;
    const Probe = () => {
      fromContext = React.useContext(CommentsCtx).isLocked;
      return null;
    };
    const element = React.createElement(
      RootThreadCtx.Provider,
      { value: rootThreadValue as never },
      React.createElement(CommentsProvider, {
        entityType: 'image',
        entityId: 1,
        level: 1,
        children: ({ isLocked }: { isLocked: boolean }) => {
          fromChild = isLocked;
          return React.createElement(Probe);
        },
      } as never)
    );

    const unmount = await mount(element);
    expect(fromChild).toBe(true);
    expect(fromContext).toBe(fromChild);
    await unmount();
  });
});
