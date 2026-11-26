import { describe, expect, it } from 'vitest';
import {
  NEW_ACCOUNT_NOTICE_END,
  NEW_ACCOUNT_NOTICE_START,
  shouldShowNewAccountNotice,
} from '~/components/Onboarding/new-account-notice';

const shown = (
  createdAt: Date | string | undefined,
  opts: Partial<{ impersonated: boolean; addingAccount: boolean }> = {}
) => shouldShowNewAccountNotice({ createdAt, impersonated: false, addingAccount: false, ...opts });
const at = (date: Date, offsetMs: number) => new Date(date.getTime() + offsetMs);

describe('the new-account notice on the Terms step', () => {
  it('shows for an account created inside the window, including as the session serialises it', () => {
    expect(shown(NEW_ACCOUNT_NOTICE_START)).toBe(true);
    expect(shown(at(NEW_ACCOUNT_NOTICE_END, -1))).toBe(true);
    expect(shown('2026-11-25T09:00:00.000Z')).toBe(true);
  });

  it('hides for an account created before or after it', () => {
    expect(shown(at(NEW_ACCOUNT_NOTICE_START, -1))).toBe(false);
    expect(shown(NEW_ACCOUNT_NOTICE_END)).toBe(false);
    expect(shown('2025-03-01T00:00:00.000Z')).toBe(false);
  });

  it('hides when the creation time is missing or unreadable', () => {
    expect(shown(undefined)).toBe(false);
    expect(shown('not a date')).toBe(false);
  });

  it('hides while impersonating, and when adding another account', () => {
    expect(shown(NEW_ACCOUNT_NOTICE_START, { impersonated: true })).toBe(false);
    expect(shown(NEW_ACCOUNT_NOTICE_START, { addingAccount: true })).toBe(false);
  });
});
