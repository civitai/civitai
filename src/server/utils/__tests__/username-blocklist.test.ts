import { describe, expect, it } from 'vitest';
import { isUsernameBlocked } from '~/server/utils/username-blocklist';

const lists = { exact: ['civitai', 'admin'], partial: ['civit', 'c1vit'] };

describe('isUsernameBlocked', () => {
  it.each([
    ['Cyrillic c', 'сivitai_support'],
    ['small caps', 'ᴄɪᴠɪᴛ_team'],
    ['fullwidth', 'ｃｉｖｉｔ'],
    ['zero-width space', 'civ​it'],
    ['l for i', 'clvitai'],
    ['1 and l for i', 'c1vlt_mod'],
    ['pipe for i', 'c|v|t'],
    ['exact entry with a digit lookalike', 'adm1n'],
    ['underscore-split', 'civ_itai'],
    ['underscore between every letter', 'c_i_v_i_t_a_i'],
    ['underscore-split partial', 'ci_vitai'],
    ['underscore-split exact entry', 'ad_min'],
    ['underscore-split with a lookalike', 'c_1_v_l_t'],
  ])('blocks a %s lookalike', (_name, username) => {
    expect(isUsernameBlocked(username, lists)).toBe(true);
  });

  it.each([
    'alice',
    'civic',
    'civil_war',
    'admin123',
    'PixelArtist',
    'bob_123',
    'pixel_art_fan',
    '_admin_fan_',
  ])('allows %s', (username) => expect(isUsernameBlocked(username, lists)).toBe(false));

  it('keeps exact entries exact', () => {
    expect(isUsernameBlocked('admin', lists)).toBe(true);
    expect(isUsernameBlocked('admins', lists)).toBe(false);
  });

  it('folds the entries too, so a lookalike entry still matches its plain spelling', () => {
    expect(isUsernameBlocked('civitfan', { exact: [], partial: ['сivit'] })).toBe(true);
  });

  it('strips underscores from the entries too', () => {
    expect(isUsernameBlocked('civitfan', { exact: [], partial: ['ci_vit'] })).toBe(true);
    expect(isUsernameBlocked('admin', { exact: ['ad_min'], partial: [] })).toBe(true);
  });
});
