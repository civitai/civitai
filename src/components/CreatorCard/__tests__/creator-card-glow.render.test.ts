import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as UserAvatarModule from '~/components/UserAvatar/UserAvatar';
import type * as UsernameModule from '~/components/User/Username';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy({}) };
});
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarModule>()),
  UserAvatar: () => null,
  UserProfileLink: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/User/Username', async (importOriginal) => ({
  ...(await importOriginal<typeof UsernameModule>()),
  Username: () => null,
  BadgeDisplay: () => null,
}));

const { IntersectionObserverProvider } = await import(
  '~/components/IntersectionObserver/IntersectionObserverProvider'
);
const { CreatorCardSimple } = await import('~/components/CreatorCard/CreatorCardSimple');
const { default: classes } = await import('~/components/CreatorCard/CreatorCard.module.css');
const { cardGlowOf } = await import('~/components/CreatorCard/card-glow');

const MYTHIC_GLOW = { glow: { color: '#22b8cf', intensity: 0.7, animated: true } };

const wearing = (...cosmetics: { type: string; data: unknown }[]) =>
  cosmetics.map((cosmetic, id) => ({
    cosmetic: { id, name: `c${id}`, source: 'Trophy', ...cosmetic },
    data: {},
  })) as unknown as UserWithCosmetics['cosmetics'];

/** The card root: the first element carrying Mantine's Card class. */
function cardRoot(
  cosmetics: UserWithCosmetics['cosmetics'],
  props: { className?: string; style?: Record<string, string> } = {}
) {
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        IntersectionObserverProvider,
        null,
        createElement(CreatorCardSimple, {
          user: { id: 7, username: 'ellie', cosmetics },
          ...props,
        })
      )
    )
  );
  const root = /<div[^>]*class="[^"]*mantine-Card-root[^"]*"[^>]*>/.exec(html)?.[0];
  if (!root) throw new Error(`no card root in ${html.slice(0, 200)}`);
  return root;
}

describe('creator card glow', () => {
  it('draws the equipped CardDecoration as a glow on the card itself', () => {
    const root = cardRoot(
      wearing({ type: 'Badge', data: { url: 'x' } }, { type: 'CardDecoration', data: MYTHIC_GLOW })
    );
    const tokens = /class="([^"]*)"/.exec(root)?.[1].split(' ') ?? [];
    expect(tokens).toEqual(expect.arrayContaining([classes.glow, classes.glowAnimated]));
    expect(root).toContain('--card-glow-color:#22b8cf');
  });

  it('keeps the caller’s class and style beside the glow', () => {
    const root = cardRoot(wearing({ type: 'CardDecoration', data: MYTHIC_GLOW }), {
      className: 'caller-class',
      style: { maxWidth: '450px' },
    });
    const classes_ = /class="([^"]*)"/.exec(root)?.[1].split(' ') ?? [];
    expect(classes_).toEqual(expect.arrayContaining(['caller-class', classes.glow]));
    expect(root).toContain('max-width:450px');
    expect(root).toContain('--card-glow-color:#22b8cf');
  });

  it('draws no glow without a CardDecoration', () => {
    const root = cardRoot(wearing({ type: 'Badge', data: { url: 'x' } }));
    expect(root).not.toContain(classes.glow);
    expect(root).not.toContain('--card-glow-color');
  });

  it('holds a glow that is not animated still', () => {
    const root = cardRoot(
      wearing({ type: 'CardDecoration', data: { glow: { color: '#ff0000', animated: false } } })
    );
    expect(root).toContain(classes.glow);
    expect(root).not.toContain(classes.glowAnimated);
  });
});

describe('cardGlowOf', () => {
  it('accepts only a hex colour, since the value lands in a custom property', () => {
    expect(cardGlowOf({ glow: { color: 'red; background: url(//x)' } })).toBeNull();
    expect(cardGlowOf({ glow: { color: 'url(//x)' } })).toBeNull();
    expect(cardGlowOf({ glow: {} })).toBeNull();
    expect(cardGlowOf(null)).toBeNull();
    expect(cardGlowOf({ glow: { color: '#abc' } })).not.toBeNull();
    expect(cardGlowOf({ glow: { color: '#22b8cfcc' } })).not.toBeNull();
  });

  it('scales the glow with intensity, clamped to 0..1', () => {
    const size = (intensity: unknown) =>
      (cardGlowOf({ glow: { color: '#22b8cf', intensity } })?.style as Record<string, string>)[
        '--card-glow-size'
      ];
    expect(size(0)).toBe('6px');
    expect(size(1)).toBe('32px');
    expect(size(5)).toBe('32px');
    expect(size(-1)).toBe('6px');
    expect(size(undefined)).toBe(size(0.6));
  });
});
