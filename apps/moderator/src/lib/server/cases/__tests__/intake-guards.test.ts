import { describe, expect, it } from 'vitest';
import { createIntakeRateLimit, IntakeRateLimitedError } from '../intake-rate-limit';
import { noticeTime, renderNotice } from '../notice-render';
import { TurnstileRefusedError, verifyTurnstile } from '../turnstile';

describe('createIntakeRateLimit', () => {
  it('refuses past the limit and opens again after the window', () => {
    let t = 0;
    const hit = createIntakeRateLimit({ limit: 2, windowMs: 1000, now: () => t });
    hit('a');
    hit('a');
    expect(() => hit('a')).toThrow(IntakeRateLimitedError);
    hit('b');
    t = 1000;
    expect(() => hit('a')).not.toThrow();
  });
});

describe('renderNotice', () => {
  it('fills known slots and leaves a slot with no value as written', () => {
    expect(renderNotice('{caseRef} / {items}', { caseRef: 'TD-1' })).toBe('TD-1 / {items}');
  });
});

describe('noticeTime', () => {
  it('writes the date US style, in UTC', () => {
    expect(noticeTime(new Date('2026-11-24T15:23:31Z'))).toBe('November 24, 2026, 3:23 PM UTC');
    expect(noticeTime(new Date('2026-12-01T00:05:00Z'))).toBe('December 1, 2026, 12:05 AM UTC');
  });
});

describe('verifyTurnstile', () => {
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body));
  const verify = (body: unknown) =>
    verifyTurnstile('t', 'ip', { secret: 's', fetcher: answer(body), hostnames: ['civitai.com'] });
  it("accepts only a token solved for the form's action, on the form's site", async () => {
    await expect(
      verify({ success: true, action: 'takedown-intake', hostname: 'Civitai.com' })
    ).resolves.toEqual({ hostname: 'civitai.com' });
    await expect(
      verify({ success: true, action: 'login', hostname: 'civitai.com' })
    ).rejects.toBeInstanceOf(TurnstileRefusedError);
    await expect(
      verify({ success: true, action: 'takedown-intake', hostname: 'evil.example' })
    ).rejects.toBeInstanceOf(TurnstileRefusedError);
    await expect(verify({ success: true, action: 'takedown-intake' })).rejects.toBeInstanceOf(
      TurnstileRefusedError
    );
  });
});
