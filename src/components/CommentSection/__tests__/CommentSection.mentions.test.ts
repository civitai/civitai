// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as FormModule from '~/libs/form';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  suggestions: [] as { id: number; label: string }[],
}));

vi.mock('next/router', () => ({ useRouter: () => ({ asPath: '/models/9' }) }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({ canWrite: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({}),
    comment: { upsert: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
  },
}));
vi.mock('~/libs/form', async (importOriginal) => ({
  ...(await importOriginal<typeof FormModule>()),
  InputRTE: ({ defaultSuggestions }: { defaultSuggestions: { id: number; label: string }[] }) => {
    mocks.suggestions = defaultSuggestions;
    return null;
  },
}));
vi.mock('~/components/CommentSection/CommentSectionItem', () => ({
  CommentSectionItem: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/Sticker/StickerPicker', () => ({ StickerPicker: () => null }));

import { MantineProvider } from '@mantine/core';

import { CommentSection } from '~/components/CommentSection/CommentSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof CommentSection>[0];

function reply(id: number, username: string, hidden: boolean) {
  return { id, hidden, user: { id: id * 10, username } };
}

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('CommentSection mention suggestions', () => {
  it("leaves a hidden reply's author out, since the placeholder withholds that name", () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          MantineProvider,
          { forceColorScheme: 'light', env: 'test' },
          createElement(CommentSection, {
            comments: [reply(2, 'visibleauthor', false), reply(3, 'hiddenauthor', true)],
            modelId: 9,
            parent: { id: 1, locked: false, user: { id: 40, username: 'threadstarter' } },
          } as unknown as Props)
        )
      );
    });

    expect(mocks.suggestions.map((s) => s.label).sort()).toEqual([
      'threadstarter',
      'visibleauthor',
    ]);
  });
});
