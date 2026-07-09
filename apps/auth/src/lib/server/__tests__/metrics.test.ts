import { describe, it, expect } from 'vitest';
import {
  register,
  loginsTotal,
  oauthEventsTotal,
  emailLoginFailuresTotal,
  captchaVerificationsTotal,
  unhandledErrorsTotal,
} from '../metrics';

// Pull the current value of a labeled (or unlabeled) counter sample straight from the registry's JSON.
async function counterValue(name: string, labels?: Record<string, string>): Promise<number | undefined> {
  const metrics = await register.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === name);
  if (!metric) return undefined;
  const sample = metric.values.find((v) => {
    const vl = v.labels ?? {};
    if (!labels) return Object.keys(vl).length === 0;
    return Object.entries(labels).every(([k, val]) => vl[k] === val);
  });
  return sample?.value;
}

describe('metrics registry', () => {
  it('registers the default Node process metrics (collectDefaultMetrics)', async () => {
    const text = await register.metrics();
    // process_cpu_user_seconds_total is one of the standard prom-client default metrics.
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('exports labeled counters as 0 before first increment (pre-declared labels)', async () => {
    // A fresh-but-never-incremented label child must serialize as 0, not be absent.
    loginsTotal.inc({ provider: 'github' });
    expect(await counterValue('hub_logins_total', { provider: 'github' })).toBe(1);

    // An unlabeled (no-label) counter still appears with value 0 before any inc.
    const text = await register.metrics();
    expect(text).toContain('hub_email_login_failures_total 0');
    expect(text).toContain('hub_unhandled_errors_total 0');
  });

  it('hub_logins_total increments per provider label', async () => {
    const before = (await counterValue('hub_logins_total', { provider: 'discord' })) ?? 0;
    loginsTotal.inc({ provider: 'discord' });
    loginsTotal.inc({ provider: 'discord' });
    expect(await counterValue('hub_logins_total', { provider: 'discord' })).toBe(before + 2);

    loginsTotal.inc({ provider: 'email' });
    expect(await counterValue('hub_logins_total', { provider: 'email' })).toBe(1);
  });

  it('hub_oauth_events_total increments per type label', async () => {
    oauthEventsTotal.inc({ type: 'token_issued' });
    expect(await counterValue('hub_oauth_events_total', { type: 'token_issued' })).toBe(1);
  });

  it('hub_email_login_failures_total increments (no labels)', async () => {
    emailLoginFailuresTotal.inc();
    expect(await counterValue('hub_email_login_failures_total')).toBe(1);
  });

  it('hub_captcha_verifications_total increments per result label', async () => {
    captchaVerificationsTotal.inc({ result: 'success' });
    captchaVerificationsTotal.inc({ result: 'http_error' });
    expect(await counterValue('hub_captcha_verifications_total', { result: 'success' })).toBe(1);
    expect(await counterValue('hub_captcha_verifications_total', { result: 'http_error' })).toBe(1);
  });

  it('hub_unhandled_errors_total increments (no labels)', async () => {
    unhandledErrorsTotal.inc();
    expect(await counterValue('hub_unhandled_errors_total')).toBe(1);
  });

  it('register.contentType is the prometheus text exposition type', () => {
    expect(register.contentType).toContain('text/plain');
  });
});
