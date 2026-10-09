// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';

/**
 * EventContentThumb hides the hat until its card is measured with `[&>button]:invisible` on the
 * wrapper, which only works while the feed's wrapper draws the hat as its direct-child button.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('the worn hat', () => {
  it("is the feed wrapper's direct-child button, beside the card", () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const hat = { type: 'hat', url: 'hat-url' } as EventDecorationData;
    act(() =>
      root!.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(
            TwCosmeticWrapper,
            { eventDecoration: hat, cardWidth: 171 },
            React.createElement('div', { 'data-testid': 'card' })
          )
        )
      )
    );
    const wrapper = host.querySelector<HTMLElement>('[data-testid="card"]')!.parentElement!;
    const direct = [...wrapper.children].filter((c) => c.matches('button'));
    expect(direct).toHaveLength(1);
    expect(direct[0].getAttribute('aria-label')).toBe('Party hat');
  });
});
