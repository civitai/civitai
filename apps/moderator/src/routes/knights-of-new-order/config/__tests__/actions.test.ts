import { beforeEach, describe, expect, it, vi } from 'vitest';

const { save, requireAccess } = vi.hoisted(() => ({ save: vi.fn(), requireAccess: vi.fn() }));

vi.mock('$lib/server/knights/sources-config.service', () => ({
  getLastSourcesChange: vi.fn(),
  getSourcesContext: vi.fn(),
  getSourcesSettings: vi.fn(),
  saveSourcesConfig: save,
}));
vi.mock('$lib/server/access', () => ({ requireAccess }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { actions, load } from '../+page.server';
import { percentToRate, rateToPercent } from '../rates';

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 77 } },
    url: new URL('http://localhost/knights-of-new-order/config'),
  } as never;
};

describe('percentToRate', () => {
  it.each([
    ['5', 0.05],
    ['0', 0],
    ['100', 1],
    ['33.33', 0.3333],
    [' 7.5 ', 0.075],
  ])('turns %j into %d', (text, rate) => expect(percentToRate(text)).toBe(rate));

  it.each(['', 'abc', '-1', '101', '1.234', '1e2', '5%', '0.5.1'])('refuses %j', (text) =>
    expect(percentToRate(text)).toBeNull()
  );

  it('shows a stored rate as the percentage that was typed', () => {
    expect(rateToPercent(0.3)).toBe('30');
    expect(rateToPercent(0.0333)).toBe('3.33');
    expect(rateToPercent(percentToRate('7.5')!)).toBe('7.5');
  });
});

describe('Knights of New Order sources config action', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a missing switch', { sfwPercent: '5', nsfwPercent: '5' }],
    ['a bad switch value', { enabled: 'on', sfwPercent: '5', nsfwPercent: '5' }],
    ['a blank rate', { enabled: 'true', sfwPercent: '', nsfwPercent: '5' }],
    ['a rate over 100', { enabled: 'true', sfwPercent: '5', nsfwPercent: '150' }],
  ])('refuses %s without saving', async (_label, fields) => {
    expect(await actions.save(formEvent(fields))).toMatchObject({ status: 400 });
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the stored 0–1 rates as the acting moderator', async () => {
    save.mockResolvedValueOnce({ ok: true, changed: true });
    expect(
      await actions.save(formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '12.5' }))
    ).toEqual({ success: true, changed: true });
    expect(save).toHaveBeenCalledWith({ enabled: true, sfwRate: 0.05, nsfwRate: 0.125 }, 77);
  });

  it('shows the service refusing as a 400', async () => {
    save.mockResolvedValueOnce({ ok: false, error: 'nope' });
    expect(
      await actions.save(formEvent({ enabled: 'false', sfwPercent: '5', nsfwPercent: '5' }))
    ).toMatchObject({ status: 400, data: { error: 'nope' } });
  });

  it('fails the action, not the page, when the store is unreachable', async () => {
    save.mockRejectedValueOnce(new Error('redis down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await actions.save(formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '5' }))
    ).toMatchObject({ status: 500 });
  });
});

describe('Knights of New Order config access', () => {
  beforeEach(() => vi.clearAllMocks());
  const denied = () =>
    requireAccess.mockImplementationOnce(() => {
      throw new Error('forbidden');
    });

  it('refuses a save without access before anything is written', async () => {
    denied();
    await expect(
      actions.save(formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '5' }))
    ).rejects.toThrow('forbidden');
    expect(requireAccess).toHaveBeenCalledWith({ id: 77 }, '/knights-of-new-order/config');
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses to load the page without access', async () => {
    denied();
    await expect(load(formEvent({}) as never)).rejects.toThrow('forbidden');
    expect(requireAccess).toHaveBeenCalledWith({ id: 77 }, '/knights-of-new-order/config');
  });
});
