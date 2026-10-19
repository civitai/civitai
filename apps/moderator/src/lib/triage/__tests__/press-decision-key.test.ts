// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { pressDecisionKey } from '../decision-form';

/** The decision bar as the detail pane renders it: one form, one submit button per decision key. */
function renderBar({ disabled = [] as number[], outside = false } = {}) {
  const host = document.createElement('div');
  if (!outside) host.setAttribute('data-triage-actions', '');
  const form = document.createElement('form');
  for (const [key, value] of [
    [1, 'Kept'],
    [2, 'Lifted'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'submit';
    button.name = 'status';
    button.value = value;
    button.dataset.triageKey = String(key);
    button.disabled = disabled.includes(key);
    form.append(button);
  }
  host.append(form);
  document.body.append(host);

  const submitted: string[] = [];
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    submitted.push(new FormData(form, submitter).get('status') as string);
  });
  return submitted;
}

afterEach(() => document.body.replaceChildren());

describe('pressDecisionKey', () => {
  it('submits the form with the pressed decision as the submitter', () => {
    const submitted = renderBar();
    pressDecisionKey(1);
    expect(submitted).toEqual(['Lifted']);
  });

  it('does nothing for a disabled decision', () => {
    const submitted = renderBar({ disabled: [1] });
    pressDecisionKey(0);
    expect(submitted).toEqual([]);
  });

  it('does nothing for a key past the decisions', () => {
    const submitted = renderBar();
    pressDecisionKey(2);
    expect(submitted).toEqual([]);
  });

  it('ignores key buttons outside the open item action bar', () => {
    const submitted = renderBar({ outside: true });
    pressDecisionKey(0);
    expect(submitted).toEqual([]);
  });
});
