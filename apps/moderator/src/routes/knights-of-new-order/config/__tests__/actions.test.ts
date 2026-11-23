import { beforeEach, describe, expect, it, vi } from 'vitest';

const { save, saveGame, saveTagReview, requireAccess } = vi.hoisted(() => ({
  save: vi.fn(),
  saveGame: vi.fn(),
  saveTagReview: vi.fn(),
  requireAccess: vi.fn(),
}));

vi.mock('$lib/server/knights/sources-config.service', () => ({
  getLastSourcesChange: vi.fn(),
  getSourcesContext: vi.fn(),
  getSourcesSettings: vi.fn(),
  saveSourcesConfig: save,
  saveGameSettings: saveGame,
  saveModTagReview: saveTagReview,
}));
vi.mock('$lib/server/access', () => ({ requireAccess }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { actions, load } from '../+page.server';
import { toggleChoice, toggleSubmission } from '../game-form';
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

  it('saves the open-item cap as a number, commas allowed, and leaves it out when blank', async () => {
    save.mockResolvedValue({ ok: true, changed: true });
    await actions.save(
      formEvent({ enabled: 'true', sfwPercent: '100', nsfwPercent: '30', maxOpen: '60,000' })
    );
    expect(save).toHaveBeenLastCalledWith(
      { enabled: true, sfwRate: 1, nsfwRate: 0.3, maxOpen: 60000 },
      77
    );
    await actions.save(
      formEvent({ enabled: 'true', sfwPercent: '100', nsfwPercent: '30', maxOpen: '' })
    );
    expect(save).toHaveBeenLastCalledWith({ enabled: true, sfwRate: 1, nsfwRate: 0.3 }, 77);
    expect(
      await actions.save(
        formEvent({ enabled: 'true', sfwPercent: '100', nsfwPercent: '30', maxOpen: '6e4' })
      )
    ).toMatchObject({ status: 400 });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('saves the yes/no share as a 0–1 share, 0 turning questions off', async () => {
    save.mockResolvedValueOnce({ ok: true, changed: true });
    await actions.save(
      formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '5', yesNoPercent: '0' })
    );
    expect(save).toHaveBeenCalledWith(
      { enabled: true, sfwRate: 0.05, nsfwRate: 0.05, yesNoShare: 0 },
      77
    );
  });

  it('leaves the yes/no share out when its box is blank, so the stored one is kept', async () => {
    save.mockResolvedValueOnce({ ok: true, changed: true });
    await actions.save(
      formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '5', yesNoPercent: ' ' })
    );
    expect(save).toHaveBeenCalledWith({ enabled: true, sfwRate: 0.05, nsfwRate: 0.05 }, 77);
  });

  it('clears the stored yes/no share when "use the default" is ticked, whatever the box holds', async () => {
    save.mockResolvedValueOnce({ ok: true, changed: true });
    await actions.save(
      formEvent({
        enabled: 'true',
        sfwPercent: '5',
        nsfwPercent: '5',
        yesNoPercent: '40',
        yesNoDefault: 'true',
      })
    );
    expect(save).toHaveBeenCalledWith(
      { enabled: true, sfwRate: 0.05, nsfwRate: 0.05, yesNoShare: null },
      77
    );
  });

  it('refuses a "use the default" value that is not true or absent', async () => {
    expect(
      await actions.save(
        formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '5', yesNoDefault: 'maybe' })
      )
    ).toMatchObject({ status: 400 });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a yes/no share over 100 without saving', async () => {
    expect(
      await actions.save(
        formEvent({ enabled: 'true', sfwPercent: '5', nsfwPercent: '5', yesNoPercent: '120' })
      )
    ).toMatchObject({ status: 400 });
    expect(save).not.toHaveBeenCalled();
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

describe('Knights of New Order game settings action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends only the posted settings, as numbers and booleans, as the acting moderator', async () => {
    saveGame.mockResolvedValueOnce({ ok: true, changed: true });
    expect(
      await actions.game(
        formEvent({
          hiddenCheckRate: '0',
          hiddenCheckSettleDelayMinutes: ' 12.5 ',
          yesNoStretch: '3',
          apprenticeSmites: 'false',
        })
      )
    ).toEqual({ success: true, changed: true });
    expect(saveGame).toHaveBeenCalledWith(
      {
        hiddenCheckRate: 0,
        hiddenCheckSettleDelayMinutes: 12.5,
        yesNoStretch: 3,
        apprenticeSmites: false,
      },
      77,
      { killSwitchesConfirmed: false }
    );
  });

  it('clears a setting when "use the Knights default" is posted, whatever its box holds', async () => {
    saveGame.mockResolvedValueOnce({ ok: true, changed: true });
    await actions.game(
      formEvent({
        yesNoMaxAgeDays: '9',
        'default.yesNoMaxAgeDays': 'true',
        'default.shopDisabled': 'true',
      })
    );
    expect(saveGame).toHaveBeenCalledWith({ yesNoMaxAgeDays: null, shopDisabled: null }, 77, {
      killSwitchesConfirmed: false,
    });
  });

  it('passes the kill switch confirmation through', async () => {
    saveGame.mockResolvedValueOnce({ ok: true, changed: true });
    await actions.game(formEvent({ conversionDisabled: 'true', confirmKillSwitches: 'true' }));
    expect(saveGame).toHaveBeenCalledWith({ conversionDisabled: true }, 77, {
      killSwitchesConfirmed: true,
    });
  });

  it.each([
    ['a word for a number', { yesNoStretch: 'four' }],
    ['a blank number', { yesNoStretch: '' }],
    ['an exponent', { hiddenCheckFailureWindowHours: '1e3' }],
    ['a toggle that is not true or false', { shopDisabled: 'on' }],
    ['nothing to change', {}],
  ])('refuses %s without saving', async (_label, fields) => {
    expect(await actions.game(formEvent(fields))).toMatchObject({ status: 400 });
    expect(saveGame).not.toHaveBeenCalled();
  });

  it('shows the service refusing (an out-of-range value, an unconfirmed kill switch) as a 400', async () => {
    saveGame.mockResolvedValueOnce({ ok: false, error: 'Shop closed needs confirming' });
    expect(await actions.game(formEvent({ shopDisabled: 'true' }))).toMatchObject({
      status: 400,
      data: { error: 'Shop closed needs confirming' },
    });
  });

  it('fails the action, not the page, when the store is unreachable', async () => {
    saveGame.mockRejectedValueOnce(new Error('redis down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await actions.game(formEvent({ yesNoStretch: '3' }))).toMatchObject({ status: 500 });
  });

  it('refuses without access before anything is written', async () => {
    requireAccess.mockImplementationOnce(() => {
      throw new Error('forbidden');
    });
    await expect(actions.game(formEvent({ yesNoStretch: '3' }))).rejects.toThrow('forbidden');
    expect(saveGame).not.toHaveBeenCalled();
  });
});

describe('toggle choices', () => {
  it('starts on the Knights default when nothing is saved, and posts nothing while it stays there', () => {
    expect(toggleChoice(undefined)).toBe('default');
    expect(toggleSubmission(undefined, 'default')).toBeNull();
  });

  it('starts on the saved value when one is saved', () => {
    expect(toggleChoice(true)).toBe('on');
    expect(toggleChoice(false)).toBe('off');
  });

  it('saves an explicit off over a Knights default the environment may have on, in one step', () => {
    expect(toggleSubmission(undefined, 'off')).toEqual({ set: false });
    expect(toggleSubmission(undefined, 'on')).toEqual({ set: true });
    expect(toggleSubmission(true, 'off')).toEqual({ set: false });
  });

  it('clears a saved value when the Knights default is chosen', () => {
    expect(toggleSubmission(true, 'default')).toBe('clear');
    expect(toggleSubmission(false, 'default')).toBe('clear');
  });

  it('posts nothing when the saved value is chosen again', () => {
    expect(toggleSubmission(false, 'off')).toBeNull();
    expect(toggleSubmission(true, 'on')).toBeNull();
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

describe('the tagReview action', () => {
  beforeEach(() => saveTagReview.mockReset().mockResolvedValue({ ok: true, changed: true }));

  it('saves the switch as the posting moderator', async () => {
    expect(await actions.tagReview(formEvent({ modTagReview: 'on' }))).toEqual({
      success: true,
      changed: true,
    });
    expect(saveTagReview).toHaveBeenCalledWith(true, 77);
    await actions.tagReview(formEvent({ modTagReview: 'off' }));
    expect(saveTagReview).toHaveBeenLastCalledWith(false, 77);
  });

  it('refuses anything but on or off, saving nothing', async () => {
    const result = await actions.tagReview(formEvent({ modTagReview: 'true' }));
    expect(result).toMatchObject({ status: 400 });
    expect(saveTagReview).not.toHaveBeenCalled();
  });
});
