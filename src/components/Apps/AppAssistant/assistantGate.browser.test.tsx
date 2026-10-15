import { describe, expect, test } from 'vitest';
import { createAssistantGate, renderChecklist } from '~/components/Apps/AppAssistant/assistantGate';

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
