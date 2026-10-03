// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CrucibleJudgeScoreRequired } from '~/components/Crucible/CrucibleJudgeScoreRequired';

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
  it('names the threshold, the judge’s own score, and how to raise it', () => {
    const el = render({ score: 120, backHref: '/crucibles/1/test' });

    expect(el.textContent).toContain('Judging needs a creator score of 500');
    expect(el.textContent).toContain('Your creator score is 120.');
    expect(el.textContent).toMatch(/react to and comment on your images and articles/);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/crucibles/1/test');
  });

  it('still explains the threshold when only the server refusal is known', () => {
    const el = render({ backHref: '/crucibles/1/test' });

    expect(el.textContent).toContain('Judging needs a creator score of 500');
    expect(el.textContent).not.toContain('Your creator score is');
  });
});
