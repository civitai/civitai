import { mirrorBlockedHashesSql } from '@civitai/shared/held-media';
import { describe, expect, it, vi } from 'vitest';
import { loggableQuery, slowQueryLogger } from './client';

const HASH = '-4276845791567733103';

describe('the slow-query log', () => {
  it('records the held-media copy statement without its hashes', async () => {
    const onSlowQuery = vi.fn();
    const log = slowQueryLogger({ target: 'write', isProd: true, onSlowQuery });

    await log({ query: mirrorBlockedHashesSql([HASH])!, params: '[]', duration: 2500 });

    expect(onSlowQuery).toHaveBeenCalledTimes(1);
    const [{ query }] = onSlowQuery.mock.calls[0];
    expect(query).not.toContain(HASH);
    expect(query).toContain('INSERT INTO "BlockedImage"');
  });

  it('fills the params of any other statement (control)', () => {
    expect(
      loggableQuery({ query: 'SELECT $1, $11', params: '["a", 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]' })
    ).toBe("SELECT 'a', 14");
  });
});
