import { describe, expect, it } from 'vitest';
import { withSubmitter } from './submitter';

describe('withSubmitter', () => {
  it('adds the pressed button the browser left out of the body', () => {
    const body = new FormData();
    body.set('item', 'token');

    withSubmitter(body, { name: 'answer', value: 'yes' });

    expect(body.get('answer')).toBe('yes');
  });

  it('keeps an answer the browser did send', () => {
    const body = new FormData();
    body.set('answer', 'no');

    withSubmitter(body, { name: 'answer', value: 'yes' });

    expect(body.getAll('answer')).toEqual(['no']);
  });

  it('leaves the body unchanged without a named submitter', () => {
    for (const submitter of [null, { name: '', value: 'yes' }, {}]) {
      const body = new FormData();
      body.set('item', 'token');

      withSubmitter(body, submitter);

      expect([...body.entries()]).toEqual([['item', 'token']]);
    }
  });
});
