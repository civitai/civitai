// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

const mocks = vi.hoisted(() => ({ viewerId: 10 }));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: mocks.viewerId }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof Avatar>()),
  UserAvatar: () => null,
  UserProfileLink: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/User/Username', async (importOriginal) => ({
  ...(await importOriginal<typeof UsernameModule>()),
  Username: ({ username }: { username: string }) => username,
}));

import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as Avatar from '~/components/UserAvatar/UserAvatar';
import type * as UsernameModule from '~/components/User/Username';
import { CreatorShowcaseView } from '~/components/CreatorJourney/CreatorShowcase';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Showcase = NonNullable<React.ComponentProps<typeof CreatorShowcaseView>['showcase']>;

const legend = (id: number) => ({
  user: { id, username: `u${id}`, image: null, profilePicture: null, cosmetics: [] },
  founding: true,
  since: null,
});
const showcase = { newSupernovas: [], legends: [legend(10), legend(18)] } as unknown as Showcase;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(onHide: () => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorShowcaseView, { showcase, onHide })
      )
    )
  );
  return [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Hide me from the showcase"]'),
  ];
}

beforeEach(() => {
  mocks.viewerId = 10;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

// Hiding writes the CALLER's own setting, so a hide button on someone else's card would hide the viewer
// while looking like "hide this person".
describe('showcase hide button', () => {
  it('appears only on the viewer’s own card, and hides on click', () => {
    const onHide = vi.fn();
    const buttons = render(onHide);
    expect(buttons).toHaveLength(1);
    const card = buttons[0].parentElement;
    expect(card?.textContent).toContain('u10');
    expect(card?.textContent).not.toContain('u18');

    act(() => buttons[0].click());
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('does not appear for a viewer who is not listed', () => {
    mocks.viewerId = 99;
    expect(render(vi.fn())).toHaveLength(0);
  });
});
