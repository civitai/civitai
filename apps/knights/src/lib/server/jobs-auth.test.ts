import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isJobRequest } from './jobs-auth';

const req = (authorization?: string) =>
  new Request('https://knights.civitai.com/api/jobs/tick', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });

beforeEach(() => {
  process.env.JOBS_TOKEN = 'job-secret';
});
afterEach(() => {
  delete process.env.JOBS_TOKEN;
});

describe('isJobRequest', () => {
  it('accepts the configured bearer token', () => {
    expect(isJobRequest(req('Bearer job-secret'))).toBe(true);
  });

  it('refuses a missing, wrong or differently-schemed token', () => {
    expect(isJobRequest(req())).toBe(false);
    expect(isJobRequest(req('Bearer nope'))).toBe(false);
    expect(isJobRequest(req('Basic job-secret'))).toBe(false);
  });

  it('is closed when no token is configured', () => {
    delete process.env.JOBS_TOKEN;
    expect(isJobRequest(req('Bearer '))).toBe(false);
    expect(isJobRequest(req('Bearer undefined'))).toBe(false);
  });
});
