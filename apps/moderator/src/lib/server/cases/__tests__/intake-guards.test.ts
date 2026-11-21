import { describe, expect, it } from 'vitest';
import { createIntakeRateLimit, IntakeRateLimitedError } from '../intake-rate-limit';
import { renderNotice } from '../notice-render';
import { noticeFrom } from '../send-notice';
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

describe('noticeFrom', () => {
  it('sends only the two DMCA forms as the DMCA sender', () => {
    expect(noticeFrom('dmca-counter-notice', 'D')).toBe('D');
    expect(noticeFrom('intimate-image-removal', 'D')).toBe('Civitai <notices@civitai.com>');
  });
});

describe('verifyTurnstile', () => {
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body));
  const verify = (body: unknown) =>
    verifyTurnstile('t', 'ip', { secret: 's', fetcher: answer(body), hostnames: ['civitai.com'] });
  it("accepts only a token solved for the form's action, on the form's site", async () => {
    await expect(
      verify({ success: true, action: 'takedown-intake', hostname: 'civitai.com' })
    ).resolves.toBeUndefined();
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
