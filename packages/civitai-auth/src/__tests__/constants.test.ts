import { describe, it, expect } from 'vitest';
import * as C from '../constants';

// These values are a cross-app contract — they must match the main app's libs/auth.ts,
// shared/constants/auth.constants.ts, and REDIS_(SYS_)KEYS.SESSION.*.
describe('constants', () => {
  it('matches the main app contract values', () => {
    expect(C.SESSION_COOKIE_BASE).toBe('civ-token');
    expect(C.SECURE_COOKIE_PREFIX).toBe('__Secure-');
    expect(C.SESSION_REFRESH_HEADER).toBe('x-session-refresh');
    expect(C.SESSION_REFRESH_COOKIE).toBe('civ-session-refresh');
    expect(C.ACCOUNT_SWITCH_PROVIDER_ID).toBe('account-switch');
    expect(C.SYNC_PARAM).toBe('sync-account');
  });
});
