// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as GateMessage from '~/components/CreatorJourney/CreatorScoreGateMessage';
import { CrucibleJudgeScoreRequired } from '~/components/Crucible/CrucibleJudgeScoreRequired';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { creatorScoreGrowsWhen } from '~/components/Account/creator-score-copy';

vi.mock('~/components/CreatorJourney/CreatorScoreGateMessage', async (importOriginal) => {
  const original = await importOriginal<typeof GateMessage>();
  const { createElement } = await import('react');
  const registry = await import('~/server/services/creator-score-unlocks.service');
  const ladder = {
    unlocks: registry.buildCreatorScoreUnlocks(registry.compiledCreatorScoreUnlockInputs),
    tiers: [],
  };
  return {
    ...original,
    CreatorScoreGateMessage: (props: { score: number | null | undefined; required: number }) =>
      createElement(original.CreatorScoreGateMessageView, { ...props, ladder, journey: true }),
  };
});

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(props: React.ComponentProps<typeof CrucibleJudgeScoreRequired>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CrucibleJudgeScoreRequired, props)
      )
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('CrucibleJudgeScoreRequired', () => {
  it('names the threshold, the judge’s own score, and the gap', () => {
    const el = render({ score: 120, backHref: '/crucibles/1/test' });

    expect(el.textContent).toContain('Judging needs a Creator Score of 500');
    expect(el.textContent).toContain("You're at 120, 380 to go.");
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/user/account#creator-score', '/crucibles/1/test']);
  });

  it('still explains the threshold when only the server refusal is known', () => {
    const el = render({ backHref: '/crucibles/1/test' });

    expect(el.textContent).toContain('Judging needs a Creator Score of 500');
    expect(el.textContent).not.toContain("You're at");
    expect(el.textContent).toContain(`grows when ${creatorScoreGrowsWhen}`);
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([CREATOR_JOURNEY_HREF, '/crucibles/1/test']);
  });
});
