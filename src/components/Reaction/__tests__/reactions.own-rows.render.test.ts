import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as TrpcUtils from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as TipBuzzButton from '~/components/Buzz/InteractiveTipBuzzButton';

const VIEWER = 7;
const OTHER = 8;

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcUtils>()), trpc: makeTrpcProxy() };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: VIEWER, muted: false }) }));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', async (importOriginal) => ({
  ...(await importOriginal<typeof TipBuzzButton>()),
  InteractiveTipBuzzButton: ({ children }: { children: unknown }) => children,
}));

const { Reactions } = await import('~/components/Reaction/Reactions');

// The article and bounty-entry pages pass their reaction rows with counts from `stats`, as here.
const metrics = { likeCount: 5, dislikeCount: 0, heartCount: 2, laughCount: 0, cryCount: 0 };
const everyone = [
  { userId: VIEWER, reaction: 'Like' },
  { userId: OTHER, reaction: 'Like' },
  { userId: OTHER, reaction: 'Heart' },
  { userId: OTHER, reaction: 'Laugh' },
] as const;
const ownOnly = everyone.filter((r) => r.userId === VIEWER);

const render = (entityType: 'article' | 'bountyEntry', entityId: number, reactions: unknown) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(Reactions, { entityType, entityId, reactions, metrics } as never)
    )
  ).replace(new RegExp(`${entityId}`, 'g'), 'ID');

describe('Reactions on articles and bounty entries read counts from stats, not the rows', () => {
  it.each(['article', 'bountyEntry'] as const)(
    '%s: dropping other users’ rows renders the same counts and the same own-reaction state',
    (entityType) => {
      const withEveryone = render(entityType, 101, everyone);
      const withOwnOnly = render(entityType, 202, ownOnly);

      expect(withOwnOnly).toBe(withEveryone);
      expect(withOwnOnly).toMatch(/>5</);
      expect(withOwnOnly).toMatch(/>2</);
    }
  );
});
