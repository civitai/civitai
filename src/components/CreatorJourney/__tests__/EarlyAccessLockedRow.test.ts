// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { EarlyAccessLockedRow } from '~/components/CreatorJourney/EarlyAccessLockedRow';
import { getEarlyAccessEntryRung } from '~/server/utils/early-access-helpers';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(score: number | undefined) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(EarlyAccessLockedRow, { score })
      )
    );
  });
  return {
    text: [...container.querySelectorAll('p')].map((p) => p.textContent).join(' | '),
    hrefs: [...container.querySelectorAll('a')].map((a) => a.getAttribute('href')),
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const rung = getEarlyAccessEntryRung() as NonNullable<ReturnType<typeof getEarlyAccessEntryRung>>;
const threshold = rung.minScore.toLocaleString('en-US');

describe('EarlyAccessLockedRow', () => {
  it('says the entry rung, where the creator stands, and what the rung grants', () => {
    const { text, hrefs } = render(4321.7);

    expect(text).toBe(
      `Early access unlocks at a Creator Score of ${threshold} | ` +
        `You're at 4,321. At ${threshold} you can hold ${rung.versions} ${
          rung.versions === 1 ? 'version' : 'versions'
        } in early access for up to ${rung.days} days. Higher scores raise both. See your journey`
    );
    expect(hrefs).toEqual([CREATOR_JOURNEY_HREF]);
  });

  it('leaves out the score when the session has none', () => {
    expect(render(undefined).text).not.toMatch(/You're at/);
  });
});
