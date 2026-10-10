import { existsSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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

  it('🔴 refuses a link outside the checkout that points into it', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const parent = mkdtempSync(join(tmpdir(), 'decision-eval-link-'));
    const link = join(parent, 'data');
    // Into a subdirectory with no .git of its own, so only the real path reveals the checkout.
    const inside = join(repoRoot, 'scripts');
    symlinkSync(inside, link, 'junction');
    try {
      expect(() => assertDataDirOutsideRepo(join(link, 'not-created', 'eval'))).toThrow(
        /inside the git checkout/
      );
      expect(existsSync(join(inside, 'not-created'))).toBe(false);
    } finally {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link);
      }
      rmdirSync(parent);
    }
    expect(existsSync(join(repoRoot, '.git'))).toBe(true);
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
    expect(assertPrivateHost(url).url.href).toContain(':8765');
  });

  it('classifies loopback, private and allowlisted hosts apart', () => {
    expect(assertPrivateHost('http://127.0.0.1:1').kind).toBe('loopback');
    expect(assertPrivateHost('http://[::1]:1').kind).toBe('loopback');
    expect(assertPrivateHost('http://10.0.0.4:1').kind).toBe('private');
    expect(assertPrivateHost('http://10.0.0.4:1', ['10.0.0.4']).kind).toBe('allowlisted');
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
    expect(assertPrivateHost('http://gpu-box:8765', ['gpu-box']).url.hostname).toBe('gpu-box');
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
    ['url', 'my profile is example.com/user/SomeName'],
    ['url', 'see ...example.com/u'],
    ['url', 'path -example.com/u'],
    ['url', 'odd a..example.com/u'],
    ['url', 'odd a.b..c.example.com/u'],
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

  it('does not take a dotted number or a plain sentence for a link', () => {
    expect(() =>
      assertNoPii('item-1', {
        body: 'Version 1.2/3 failed; paid 5.00 USD for 1/2 of it. See section 4.1.',
      })
    ).not.toThrow();
  });

  it('🔴 checks a long dotted run in linear time, so one prompt cannot stall a run', () => {
    const started = performance.now();
    // Sized so a quadratic revert fails in seconds, not minutes; linear is sub-millisecond.
    for (const body of ['ab.'.repeat(30_000), 'a'.repeat(25_000), 'a-'.repeat(12_000)]) {
      expect(() => assertNoPii('item-1', { body })).not.toThrow();
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('passes redacted text', () => {
    expect(() =>
      assertNoPii('item-1', { body: 'My Buzz purchase of 5000 did not arrive [email removed].' })
    ).not.toThrow();
  });
});

describe('assertArmAllowed', () => {
  const selfHosted = {
    hosting: 'self-hosted' as const,
    zeroDataRetention: true,
    hostKind: 'loopback' as const,
  };
  const selfHostedPrivate = { ...selfHosted, hostKind: 'private' as const };
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

  it('lets any data class go to a self-hosted arm on loopback', () => {
    expect(() => assertArmAllowed('moderation-image', selfHosted)).not.toThrow();
  });

  it('🔴 refuses moderation images on a bare private range, which also covers a rented box on a VPN', () => {
    expect(() => assertArmAllowed('moderation-image', selfHostedPrivate)).toThrow(
      /not a bare private range/
    );
    expect(() =>
      assertArmAllowed('moderation-image', { ...selfHosted, hostKind: 'allowlisted' })
    ).not.toThrow();
    expect(() => assertArmAllowed('support-text', selfHostedPrivate)).not.toThrow();
  });
});
