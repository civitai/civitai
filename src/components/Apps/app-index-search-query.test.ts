import { describe, expect, it } from 'vitest';
import { appIndexServerQuery } from '~/components/Apps/app-index-search-query';

describe('appIndexServerQuery', () => {
  it('sends the trimmed search only with the flag on and the server saying routable', () => {
    expect(
      appIndexServerQuery({ flagOn: true, serverRoutable: true, search: '  tile maker ' })
    ).toBe('tile maker');
  });

  it.each<[string, boolean, boolean | undefined, string]>([
    ['flag off', false, true, 'tile maker'],
    ['flag on, the server said not routable', true, false, 'tile maker'],
    ['flag on, no page has said yet', true, undefined, 'tile maker'],
    ['routable, but nothing typed', true, true, '   '],
  ])(
    '%s: no query, so the request and its key are unchanged',
    (_, flagOn, serverRoutable, search) => {
      expect(appIndexServerQuery({ flagOn, serverRoutable, search })).toBeUndefined();
    }
  );
});
