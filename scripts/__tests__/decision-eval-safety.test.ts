import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  assertArmAllowed,
  assertDataDirOutsideRepo,
  assertNoPii,
  assertPrivateHost,
  EvalSafetyError,
} from '../decision-eval/safety';

describe('assertDataDirOutsideRepo', () => {
  const repo = resolve('/work/repo');
  const exists = (p: string) => p === resolve(repo, '.git');

  it('🔴 refuses a directory anywhere inside a git checkout', () => {
    expect(() => assertDataDirOutsideRepo(resolve(repo, '_local/eval'), exists)).toThrow(
      EvalSafetyError
    );
    expect(() => assertDataDirOutsideRepo(repo, exists)).toThrow(/inside the git checkout/);
  });

  it('accepts a directory outside every checkout', () => {
    expect(assertDataDirOutsideRepo(resolve('/data/eval'), exists)).toBe(resolve('/data/eval'));
  });

  it('refuses the real repository this test runs in', () => {
    expect(() => assertDataDirOutsideRepo(resolve(__dirname, 'eval-data'))).toThrow(
      EvalSafetyError
    );
  });
});

describe('assertPrivateHost', () => {
  it.each([
    'http://127.0.0.1:8765',
    'http://localhost:8765',
    'http://[::1]:8765',
    'http://10.0.0.4:8765',
    'http://172.16.9.9:8765',
    'http://192.168.1.20:8765',
    'http://100.101.1.2:8765',
  ])('accepts %s', (url) => {
    expect(assertPrivateHost(url).href).toContain(':8765');
  });

  it.each([
    'http://8.8.8.8:8765',
    'http://172.32.0.1:8765',
    'https://imajev.example.com',
    'http://192.169.0.1',
    'ftp://127.0.0.1',
  ])('🔴 refuses %s', (url) => {
    expect(() => assertPrivateHost(url)).toThrow(EvalSafetyError);
  });

  it('accepts a public-looking name only when it is allowlisted by exact name', () => {
    expect(() => assertPrivateHost('http://gpu-box:8765')).toThrow(EvalSafetyError);
    expect(assertPrivateHost('http://gpu-box:8765', ['gpu-box']).hostname).toBe('gpu-box');
    expect(() => assertPrivateHost('http://gpu-box.evil.com', ['gpu-box'])).toThrow(
      EvalSafetyError
    );
  });
});

describe('assertNoPii', () => {
  it.each([
    ['email', 'reach me at jane.doe+x@example.co.uk please'],
    ['url', 'see https://example.com/u/1'],
    ['url', 'see www.example.com'],
    ['handle', 'ping @someuser about it'],
  ])('🔴 refuses a %s-shaped string', (name, text) => {
    expect(() => assertNoPii('item-1', { body: text })).toThrow(`contains a ${name}-shaped string`);
  });

  it('never echoes the matched text', () => {
    try {
      assertNoPii('item-1', { body: 'jane@example.com' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('jane');
    }
  });

  it('passes redacted text', () => {
    expect(() =>
      assertNoPii('item-1', { body: 'My Buzz purchase of 5000 did not arrive [email removed].' })
    ).not.toThrow();
  });
});

describe('assertArmAllowed', () => {
  const selfHosted = { hosting: 'self-hosted' as const, zeroDataRetention: true };
  const hostedZdr = { hosting: 'third-party' as const, zeroDataRetention: true };
  const hostedRetaining = { hosting: 'third-party' as const, zeroDataRetention: false };

  it('🔴 never lets moderation images reach a third-party arm, even with zero retention', () => {
    expect(() => assertArmAllowed('moderation-image', hostedZdr)).toThrow(EvalSafetyError);
  });

  it('🔴 refuses text on a third-party arm that does not send zero data retention', () => {
    expect(() => assertArmAllowed('support-text', hostedRetaining)).toThrow(/zero data retention/);
    expect(() => assertArmAllowed('public-text', hostedRetaining)).toThrow(EvalSafetyError);
  });

  it('lets text go to a third-party arm with zero data retention', () => {
    expect(() => assertArmAllowed('support-text', hostedZdr)).not.toThrow();
  });

  it('lets any data class go to a self-hosted arm', () => {
    expect(() => assertArmAllowed('moderation-image', selfHosted)).not.toThrow();
  });
});
