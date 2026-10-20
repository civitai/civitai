// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  shareable: undefined as boolean | undefined,
  profilePicture: null as { url: string; nsfwLevel: number; type: string } | null,
  metaProps: [] as Record<string, unknown>[],
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: mocks.query }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/user/maker' }));
// What the page hands its <head> is what this file checks; the rest of the layout is out of scope.
vi.mock('~/components/Meta/Meta', () => ({
  Meta: (props: Record<string, unknown>) => {
    mocks.metaProps.push(props);
    return null;
  },
}));
vi.mock('~/components/AppLayout/AppLayout', () => ({ AppLayout: () => null }));
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
vi.mock('~/hooks/hidden-preferences', () => ({
  useHiddenPreferencesData: () => ({ blockedUsers: [] }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'userProfile.get': {
      useQuery: () => ({
        isInitialLoading: false,
        data: {
          id: 7,
          username: 'maker',
          image: 'https://example.test/avatar.png',
          profilePicture: mocks.profilePicture,
          stats: { followerCountAllTime: 1, thumbsUpCountAllTime: 1, downloadCountAllTime: 1 },
        },
      }),
    },
    'userProfile.overview': { useQuery: () => ({ data: { modelCount: 1 } }) },
    'creatorJourney.isMilestoneShareable': { useQuery: () => ({ data: mocks.shareable }) },
  }),
}));

import type * as Trpc from '~/utils/trpc';
import { ogImageUrl } from '~/components/Meta/og-image-url';
import { NsfwLevel } from '~/server/common/enums';
import { ProfileLayout2 } from '~/components/Profile/ProfileLayout2';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

type Schema = {
  primaryImageOfPage: { contentUrl?: string };
  mainEntity: { image?: string };
};

function headFor(query: Record<string, string>, shareable: boolean | undefined) {
  mocks.query = { username: 'maker', ...query };
  mocks.shareable = shareable;
  mocks.metaProps = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ProfileLayout2, null, React.createElement('div'))
      )
    )
  );
  const props = mocks.metaProps.at(-1) as { ogEndpoint?: string; schema?: Schema };
  return {
    ogEndpoint: props.ogEndpoint,
    hasSchema: !!props.schema,
    pageImage: props.schema?.primaryImageOfPage.contentUrl,
    personImage: props.schema?.mainEntity.image,
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mocks.profilePicture = null;
});

// Telegram previewed a shared tier link on civitai.com with the avatar, not the card. Model pages,
// whose JSON-LD carries no page image, preview their card there; the profile's page image was the
// avatar. So on a shareable link every image the head names is the card.
describe('profile head on a shared milestone link', () => {
  it('names the card as the JSON-LD page image and person image, as og:image does', () => {
    const head = headFor({ milestone: 'supernova' }, true);
    const card = ogImageUrl('/api/og?type=milestone&id=7.supernova');
    expect(head.ogEndpoint).toBe('/api/og?type=milestone&id=7.supernova');
    expect(head.pageImage).toBe(card);
    expect(head.personImage).toBe(card);
  });

  it('does the same for a shared achievement, named by its key', () => {
    const head = headFor({ milestone: 'reach:downloads-10000' }, true);
    const card = ogImageUrl('/api/og?type=milestone&id=7.reach:downloads-10000');
    expect(head.ogEndpoint).toBe('/api/og?type=milestone&id=7.reach:downloads-10000');
    expect(head.pageImage).toBe(card);
    expect(head.personImage).toBe(card);
  });

  it.each([
    ['no milestone in the link', {}, undefined],
    ['a milestone whose card will not render', { milestone: 'supernova' }, false],
  ])('keeps the avatar for %s', (_, query, shareable) => {
    mocks.profilePicture = { url: 'avatar-key', nsfwLevel: NsfwLevel.PG, type: 'image' };
    const head = headFor(query, shareable);
    expect(head.ogEndpoint).toBeUndefined();
    expect(head.pageImage).toContain('avatar-key');
    expect(head.personImage).toContain('avatar-key');
  });
});

// Crawlers and link unfurlers read JSON-LD without passing the page's rating gate.
describe('profile head with an uploaded avatar', () => {
  it('names a safe avatar as the page image', () => {
    mocks.profilePicture = { url: 'avatar-key', nsfwLevel: NsfwLevel.PG, type: 'image' };
    const head = headFor({}, undefined);
    expect(head.pageImage).toContain('avatar-key');
    expect(head.personImage).toContain('avatar-key');
  });

  it.each([
    ['R', NsfwLevel.R],
    ['unrated', 0],
  ])('names no page image for a %s avatar', (_, nsfwLevel) => {
    mocks.profilePicture = { url: 'avatar-key', nsfwLevel, type: 'image' };
    const head = headFor({}, undefined);
    expect(head.pageImage).toBeUndefined();
    expect(head.personImage).toBeUndefined();
  });

  it('names no page image from the unrated account image when there is no uploaded avatar', () => {
    const head = headFor({}, undefined);
    expect(head.hasSchema).toBe(true);
    expect(head.pageImage).toBeUndefined();
    expect(head.personImage).toBeUndefined();
  });
});
