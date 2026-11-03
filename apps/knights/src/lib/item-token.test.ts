import { describe, expect, it } from 'vitest';
import { holdToken, itemKey, releaseToken } from './item-token';

const question = { key: 'knights.image.nsfwLevel', prompt: 'Rate it' };

describe('holdToken', () => {
  it('keeps the first token while the same item is served again', () => {
    const key = itemKey({ src: 'a.jpg' }, question);
    const first = holdToken(null, key, 'token-1');
    expect(holdToken(first, key, 'token-2')?.token).toBe('token-1');
  });

  it("keeps the token across a dismissal, but uses the next load's token after a vote or skip", () => {
    const key = itemKey({ src: 'a.jpg' }, question);
    let held = holdToken(null, key, 'token-1');
    held = holdToken(held, key, 'token-2'); // a notice was dismissed
    expect(held?.token).toBe('token-1');

    held = releaseToken(); // the player answered or skipped; another item may show the same image and question
    expect(holdToken(held, key, 'token-3')?.token).toBe('token-3');
  });

  it('takes the new token for another image or another question', () => {
    const first = holdToken(null, itemKey({ src: 'a.jpg' }, question), 'token-1');
    expect(holdToken(first, itemKey({ src: 'b.jpg' }, question), 'token-2')?.token).toBe('token-2');
    const asked = itemKey({ src: 'a.jpg' }, { key: 'yesno', prompt: 'Is it?' });
    expect(holdToken(first, asked, 'token-3')?.token).toBe('token-3');
  });

  it('lets go when there is no item', () => {
    const first = holdToken(null, itemKey({ src: 'a.jpg' }, question), 'token-1');
    expect(holdToken(first, null, null)).toBeNull();
  });
});
