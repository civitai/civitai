// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { clickDecision, pressDecisionKey } from '../decision-form';

/** The decision bar as the detail pane renders it: one form, one submit button per decision key. */
function renderBar({
  disabled = [] as number[],
  outside = false,
  withReasons = [] as number[],
} = {}) {
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
    if (withReasons.includes(key)) button.dataset.triageReasons = '';
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

describe('clickDecision', () => {
  it('submits even a decision that has reasons, for the list to finish with', () => {
    const submitted = renderBar({ withReasons: [1] });
    clickDecision(0);
    expect(submitted).toEqual(['Kept']);
  });
});

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

  it('opens the reason list instead of submitting a decision that has reasons', () => {
    const submitted = renderBar({ withReasons: [1] });
    const opened: number[] = [];
    pressDecisionKey(0, (index) => opened.push(index));
    expect(opened).toEqual([0]);
    expect(submitted).toEqual([]);
  });

  it('still submits a decision without reasons at once, beside one that has them', () => {
    const submitted = renderBar({ withReasons: [1] });
    const opened: number[] = [];
    pressDecisionKey(1, (index) => opened.push(index));
    expect(opened).toEqual([]);
    expect(submitted).toEqual(['Lifted']);
  });

  it('does not open the reason list for a disabled decision', () => {
    renderBar({ withReasons: [1], disabled: [1] });
    const opened: number[] = [];
    pressDecisionKey(0, (index) => opened.push(index));
    expect(opened).toEqual([]);
  });
});
