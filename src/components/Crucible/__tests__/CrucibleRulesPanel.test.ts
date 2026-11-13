import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { CrucibleRulesPanel } from '~/components/Crucible/CrucibleRulesPanel';

const render = (rules: { label: string; value: string; visible?: boolean }[]) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(CrucibleRulesPanel, { rules }))
  );

describe('CrucibleRulesPanel', () => {
  it('tells entrants a creator wins at most one prize, on every crucible', () => {
    const html = render([{ label: 'Ties', value: 'The earlier entry ranks higher' }]);
    expect(html).toContain('One Prize Per Creator');
    expect(html).toContain(
      'Each creator can win at most one prize. If you place more than once, your best entry counts and the next creator moves up.'
    );
  });

  it('still leaves out a rule marked not visible', () => {
    const html = render([{ label: 'Total Entry Cap', value: '10 entries', visible: false }]);
    expect(html).not.toContain('Total Entry Cap');
  });
});
