import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
}));

const { Username } = await import('~/components/User/Username');
const { NamePlateText } = await import('~/components/User/NamePlateText');

const gradient = { from: '#ffd43b', to: '#f59f00', deg: 180 };

// Rendered without BrowserSettingsProvider on purpose: Username mounts in places that have none,
// and reading the autoplay setting must not make it throw there.
function renderUsername(data: Record<string, unknown>) {
  const cosmetics = [{ cosmetic: { type: 'NamePlate', data }, data: null }];
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(Username, {
        username: 'ellie',
        cosmetics: cosmetics as unknown as UserWithCosmetics['cosmetics'],
      })
    )
  );
}

describe('Username nameplate', () => {
  it('sweeps an animated plate and keeps its own drop shadow', () => {
    const html = renderUsername({ variant: 'gradient', gradient, animated: true });
    expect(html).toContain('animate-nameplate-sweep');
    expect(html).toContain('--text-gradient:linear-gradient(90deg, #ffd43b, #f59f00, #ffd43b)');
    expect(html).toContain('drop-shadow-[1px_1px_1px_rgba(0,0,0,0.8)]');
    expect(html).not.toContain('animated');
  });

  it('leaves a static plate on Mantine’s own gradient', () => {
    const html = renderUsername({ variant: 'gradient', gradient });
    expect(html).not.toContain('animate-nameplate-sweep');
    expect(html).toContain('--text-gradient:linear-gradient(180deg, #ffd43b 0%, #f59f00 100%)');
  });

  it('holds still when the caller turns autoplay off', () => {
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(
          NamePlateText,
          { nameplate: { variant: 'gradient', gradient, animated: true }, autoplay: false },
          'ellie'
        )
      )
    );
    expect(html).not.toContain('animate-nameplate-sweep');
  });
});
