import { describe, expect, it } from 'vitest';
import {
  canPutOn,
  getHatState,
  pickDefaultHat,
} from '~/components/Decorations/event-hat-picker.utils';

const minutes = (m: number) => m * 60_000;
const fetchedAt = 1_800_000_000_000;
const here = { entityType: 'Image', entityId: 10, joinCosmeticId: 1, now: fetchedAt, fetchedAt };
const later = (ms: number) => ({ ...here, now: fetchedAt + ms });

const hat = (
  cosmeticId: number,
  placedOn: { entityType: string; entityId: number; title?: string | null } | null = null,
  moveCooldownLeftMs = 0
) => ({ cosmeticId, placedOn, moveCooldownLeftMs });

describe('getHatState', () => {
  it('reads a hat on this very content as here, even while it cools down', () => {
    expect(getHatState(hat(5, { entityType: 'Image', entityId: 10 }, minutes(4)), here)).toEqual({
      kind: 'here',
    });
  });

  it('matches this content on type as well as id', () => {
    expect(getHatState(hat(5, { entityType: 'Model', entityId: 10, title: 'M' }), here)).toEqual({
      kind: 'elsewhere',
      entityType: 'Model',
      title: 'M',
    });
  });

  it('counts the server cooldown down by the time since the hats arrived, rounding up', () => {
    const cooling = hat(5, { entityType: 'Image', entityId: 99 }, minutes(8));
    expect(getHatState(cooling, here)).toEqual({ kind: 'cooldown', minutes: 8 });
    expect(getHatState(cooling, later(minutes(2.8)))).toEqual({
      kind: 'cooldown',
      minutes: 6,
    });
  });

  it('puts a cooling hat ahead of being free', () => {
    expect(getHatState(hat(1, null, minutes(3)), here)).toEqual({
      kind: 'cooldown',
      minutes: 3,
    });
  });

  it('frees a hat once its cooldown has run out since the hats arrived', () => {
    const moved = hat(5, { entityType: 'Image', entityId: 99, title: 'Neon alley' }, minutes(3));
    expect(getHatState(moved, later(minutes(3)))).toEqual({
      kind: 'elsewhere',
      entityType: 'Image',
      title: 'Neon alley',
    });
  });

  it('keeps untitled content untitled, with its type', () => {
    expect(getHatState(hat(5, { entityType: 'Article', entityId: 99, title: null }), here)).toEqual(
      { kind: 'elsewhere', entityType: 'Article', title: null }
    );
  });

  it('marks the team join cap as free, and any other loose hat as ready', () => {
    expect(getHatState(hat(1), here)).toEqual({ kind: 'free' });
    expect(getHatState(hat(2), here)).toEqual({ kind: 'ready' });
    expect(getHatState(hat(1), { ...here, joinCosmeticId: undefined })).toEqual({ kind: 'ready' });
  });
});

describe('canPutOn', () => {
  it('refuses only a hat already here or still cooling', () => {
    expect(canPutOn({ kind: 'here' })).toBe(false);
    expect(canPutOn({ kind: 'cooldown', minutes: 1 })).toBe(false);
    expect(canPutOn({ kind: 'elsewhere', entityType: 'Image', title: 'x' })).toBe(true);
    expect(canPutOn({ kind: 'free' })).toBe(true);
    expect(canPutOn({ kind: 'ready' })).toBe(true);
  });
});

describe('pickDefaultHat', () => {
  const worn = hat(3, { entityType: 'Image', entityId: 99 });
  const cooling = hat(4, { entityType: 'Image', entityId: 98 }, minutes(5));
  const loose = hat(2);

  it('opens on a hat that is not worn anywhere', () => {
    expect(pickDefaultHat([cooling, worn, loose], here)).toBe(loose);
  });

  it('falls back to a worn hat that can move, then to the first', () => {
    expect(pickDefaultHat([cooling, worn], here)).toBe(worn);
    expect(pickDefaultHat([cooling], here)).toBe(cooling);
    const alsoCooling = hat(6, { entityType: 'Image', entityId: 97 }, minutes(7));
    expect(pickDefaultHat([cooling, alsoCooling], here)).toBe(cooling);
  });

  it('has nothing to open on with no hats', () => {
    expect(pickDefaultHat([], here)).toBeUndefined();
  });
});
