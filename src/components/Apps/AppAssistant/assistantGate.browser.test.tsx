import { describe, expect, test } from 'vitest';
import {
  createAssistantGate,
  renderChecklist,
  renderReady,
} from '~/components/Apps/AppAssistant/assistantGate';

describe('the set_checklist card', () => {
  test('shows every item with whether it is done', () => {
    const card = renderChecklist({
      name: 'set_checklist',
      input: { items: [{ label: 'Type a description', done: true }, { label: 'Download' }] },
      state: 'done',
    });
    expect(card?.getAttribute('aria-label')).toBe('Feature checklist');
    expect([...card!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '☑ Type a description',
      '☐ Download',
    ]);
  });

  test('keeps the default card for input it cannot read', () => {
    expect(
      renderChecklist({ name: 'set_checklist', input: { items: 'oops' }, state: 'calling' })
    ).toBeUndefined();
  });

  test('is the view the tool carries', () => {
    expect(createAssistantGate().tools.set_checklist.render).toBe(renderChecklist);
  });
});

describe('the report_ready card', () => {
  test('says the checks passed when report_ready did', () => {
    const card = renderReady({
      name: 'report_ready',
      input: {},
      state: 'done',
      output: { ready: true, note: 'x' },
    });
    expect(card?.getAttribute('role')).toBe('status');
    expect(card?.textContent).toBe(
      '✓ Checked: the preview renders, the tests and the typecheck pass, and every checklist item is done.'
    );
  });

  test.each([
    { state: 'error' as const, error: 'Not ready yet.' },
    { state: 'calling' as const },
    { state: 'done' as const, output: { error: 'Not ready yet.' } },
  ])('keeps the default card for a $state call that did not pass', (call) => {
    expect(renderReady({ name: 'report_ready', input: {}, ...call })).toBeUndefined();
  });

  test('is the view the tool carries', () => {
    expect(createAssistantGate().tools.report_ready.render).toBe(renderReady);
  });
});
