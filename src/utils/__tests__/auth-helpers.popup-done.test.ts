import { describe, expect, it } from 'vitest';

import { popupDoneTarget } from '~/utils/auth-helpers';
import {
  SAFE_RETURN_PATHS,
  UNSAFE_RETURN_PATHS,
} from '../../../packages/civitai-auth/src/__tests__/return-path-cases';

const search = (cb: string) => `?${new URLSearchParams({ cb }).toString()}`;

describe('popupDoneTarget', () => {
  it.each(UNSAFE_RETURN_PATHS)('falls back to / for: %s', (_name, raw) => {
    expect(popupDoneTarget(search(raw))).toBe('/');
  });

  it.each(SAFE_RETURN_PATHS)('keeps: %s', (_name, raw, expected) => {
    expect(popupDoneTarget(search(raw))).toBe(expected);
  });

  it('falls back to / when cb is absent', () => {
    expect(popupDoneTarget('')).toBe('/');
    expect(popupDoneTarget('?other=1')).toBe('/');
  });
});
