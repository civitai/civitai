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

  test('tells the user a list planned on sample data is not real Civitai data, and only then', () => {
    const items = [{ label: 'Search models' }];
    const card = (data?: string) =>
      renderChecklist({
        name: 'set_checklist',
        input: { items, ...(data ? { data } : {}) },
        state: 'done',
      });
    expect(card('sample')?.textContent).toBe(
      'Feature checklist☐ Search models⚠ Sample data: this app will show made-up examples, not real Civitai data.'
    );
    for (const data of [undefined, 'civitai', 'none'])
      expect(card(data)?.textContent).toBe('Feature checklist☐ Search models');
  });

  test('is the view the tool carries', () => {
    const call = {
      name: 'set_checklist',
      input: { items: [{ label: 'Download' }] },
      state: 'done' as const,
    };
    expect((createAssistantGate().tools.set_checklist.render!(call) as HTMLElement).outerHTML).toBe(
      renderChecklist(call)!.outerHTML
    );
  });
});

describe('the checklist card offers no confirmation', () => {
  const items = [{ label: 'Ask questions' }];
  const conv = { conversationId: 'c', reply: 1 };
  const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };

  test('a first list shows as the plan, with no button to press: the reply goes on building', async () => {
    const gate = createAssistantGate();
    gate.beforeToolCall('set_checklist', { items }, conv);
    const output = await gate.tools.set_checklist.execute({ items }, ctx);
    expect(output).not.toHaveProperty('awaitsUser');
    const card = gate.tools.set_checklist.render!({
      name: 'set_checklist',
      input: { items },
      state: 'done',
      output,
    }) as HTMLElement;
    expect(card.getAttribute('aria-label')).toBe('Feature checklist');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('the report_ready card', () => {
  test('says what the checks were when report_ready passed: a test browser, not the live preview', () => {
    const card = renderReady({
      name: 'report_ready',
      input: {},
      state: 'done',
      output: { ready: true, note: 'x' },
    });
    expect(card?.getAttribute('role')).toBe('status');
    expect(card?.textContent).toBe(
      '✓ Checked: the app renders in a test browser, the tests and the typecheck pass, and every checklist item is done.'
    );
  });

  test('says so when the app shows sample data', () => {
    const card = renderReady({
      name: 'report_ready',
      input: { data: 'sample' },
      state: 'done',
      output: { ready: true, data: 'sample', note: 'x' },
    });
    expect(card?.textContent).toBe(
      '✓ Checked: the app renders in a test browser, the tests and the typecheck pass, and every checklist item is done. ⚠ This app shows sample data, not real Civitai data.'
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
