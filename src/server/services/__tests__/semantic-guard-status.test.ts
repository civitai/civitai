import { describe, expect, it, vi } from 'vitest';
import {
  createGuardStatusReader,
  parseGuardStatus,
  UNKNOWN_GUARD_STATUS,
} from '~/server/services/semantic-guard-status';

describe('parseGuardStatus', () => {
  it('keys on mode and version, and reads the rules whose rows keep no ids', () => {
    const status = parseGuardStatus({
      mode: 'shadow',
      version: 'v7',
      withhold_results: ['block:rule_a', 'rule_a+rule_b'],
      concepts: ['rule_a'],
    });
    expect(status.key).toBe('shadow:v7');
    expect([...(status.withholdResults ?? [])]).toEqual(['block:rule_a', 'rule_a+rule_b']);
  });

  it.each(['none', '', 'null'])(
    'keys a guard with no artifact apart from version %j',
    (version) => {
      expect(parseGuardStatus({ mode: 'shadow', version: null }).key).not.toBe(
        parseGuardStatus({ mode: 'shadow', version }).key
      );
    }
  );

  it('gives no withheld list when the service sends none, so every rule withholds', () => {
    expect(parseGuardStatus({ mode: 'enforce', version: 'v1' }).withholdResults).toBeNull();
    expect(
      parseGuardStatus({ mode: 'enforce', version: 'v1', withhold_results: [] }).withholdResults
    ).toBeNull();
  });

  it.each([
    ['nothing', undefined],
    ['no mode', { version: 'v1' }],
    ['a mode it does not know', { mode: 'loud', version: 'v1' }],
    ['a version that is not a string', { mode: 'shadow', version: 7 }],
  ])('is unknown for %s', (_, raw) => {
    expect(parseGuardStatus(raw)).toBe(UNKNOWN_GUARD_STATUS);
  });
});

describe('createGuardStatusReader', () => {
  it('reads once for searches arriving together, and again only after 30 s', async () => {
    let t = 0;
    const fetchStatus = vi.fn(async () => ({ mode: 'shadow', version: 'v1' }));
    const read = createGuardStatusReader(fetchStatus, () => t);

    const together = await Promise.all([read(), read(), read()]);
    expect(together.map((s) => s.key)).toEqual(['shadow:v1', 'shadow:v1', 'shadow:v1']);
    t = 29_000;
    await read();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    fetchStatus.mockResolvedValueOnce({ mode: 'enforce', version: 'v1' });
    t = 31_000;
    expect((await read()).key).toBe('enforce:v1');
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('answers unknown when the read fails, and retries within seconds', async () => {
    let t = 0;
    const fetchStatus = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('guard status 404'))
      .mockResolvedValue({ mode: 'shadow', version: 'v1' });
    const read = createGuardStatusReader(fetchStatus, () => t);

    expect(await read()).toBe(UNKNOWN_GUARD_STATUS);
    t = 6_000;
    expect((await read()).key).toBe('shadow:v1');
  });
});
