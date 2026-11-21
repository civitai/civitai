import { describe, expect, it } from 'vitest';
import { CASE_LINK_KEY, takeCaseLinkToken } from '../case-link-token';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('takeCaseLinkToken', () => {
  it('returns the token and leaves nothing in storage, before any exchange has answered', () => {
    const storage = memoryStorage();
    storage.setItem(`${CASE_LINK_KEY}:TD-26-ABC123`, 'tok');
    expect(takeCaseLinkToken('TD-26-ABC123', storage)).toBe('tok');
    expect(storage.length).toBe(0);
    expect(takeCaseLinkToken('TD-26-ABC123', storage)).toBeNull();
  });

  it("does not take another case's token", () => {
    const storage = memoryStorage();
    storage.setItem(`${CASE_LINK_KEY}:TD-26-OTHER1`, 'tok');
    expect(takeCaseLinkToken('TD-26-ABC123', storage)).toBeNull();
    expect(storage.length).toBe(1);
  });
});
