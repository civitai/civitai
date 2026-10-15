import { describe, expect, it } from 'vitest';
import { rulingLabel } from '../verdict-label';

const form = (status?: string) => {
  const data = new FormData();
  if (status !== undefined) data.set('status', status);
  return data;
};

describe('rulingLabel', () => {
  it('reads the label from the verdict the form posts', () => {
    expect(rulingLabel(form('Upheld'))).toBe('Mute upheld');
    expect(rulingLabel(form('Overturned'))).toBe('Mute removed');
  });

  it('gives no label for a missing or unknown status rather than a wrong one', () => {
    expect(rulingLabel(form())).toBe('');
    expect(rulingLabel(form('Pending'))).toBe('');
    expect(rulingLabel(form(''))).toBe('');
  });
});
