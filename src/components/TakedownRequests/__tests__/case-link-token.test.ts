import { describe, expect, it } from 'vitest';
import { CASE_LINK_KEY, stripLinkTokenScript, takeCaseLinkToken } from '../case-link-token';

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

describe('stripLinkTokenScript', () => {
  const run = (publicRef: string | null, hash: string) => {
    const storage = memoryStorage();
    const location = { hash, pathname: '/requests/case/whatever' };
    const replaced: string[] = [];
    const history = {
      replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url),
    };
    new Function('location', 'history', 'sessionStorage', stripLinkTokenScript(publicRef))(
      location,
      history,
      storage
    );
    return { storage, replaced };
  };

  it('takes the token out of the address and keeps it for a valid case', () => {
    const { storage, replaced } = run('TD-26-ABC123', '#t=tok%2Fen');
    expect(replaced).toEqual(['/requests/case/whatever']);
    expect(storage.getItem(`${CASE_LINK_KEY}:TD-26-ABC123`)).toBe('tok/en');
  });

  it('still takes it out of the address when the page cannot show the case, keeping nothing', () => {
    const { storage, replaced } = run(null, '#t=tok');
    expect(replaced).toEqual(['/requests/case/whatever']);
    expect(storage.length).toBe(0);
  });

  it('leaves an address without a token alone', () => {
    expect(run('TD-26-ABC123', '').replaced).toEqual([]);
  });
});
