import { beforeEach, describe, expect, it } from 'vitest';
import {
  isTrustedOrchestratorUrl,
  logHostOf,
} from '~/server/services/orchestrator/trusted-blob-url';
import { setEnv } from '~/__tests__/mocks/env.mock';

const BLOB = '/v2/consumer/blobs/ABC123.safetensors?sig=x&exp=2099-01-01T00:00:00Z';

describe('logHostOf', () => {
  it('names the host, and says so when there is not one', () => {
    expect(logHostOf('https://orchestration.civitai.com:8443/x')).toBe(
      'orchestration.civitai.com:8443'
    );
    expect(logHostOf('not a url')).toBe('unparseable');
  });
});

describe('isTrustedOrchestratorUrl', () => {
  beforeEach(() => {
    setEnv({ ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com' });
  });

  it('accepts the configured orchestrator host', () => {
    expect(isTrustedOrchestratorUrl(`https://orchestration.civitai.com${BLOB}`)).toBe(true);
  });

  // Every host observed in stored epoch urls, including the low-volume ones — a blocked host here
  // is a publish or download that fails for a run nobody can re-create.
  it('accepts every host stored rows actually carry', () => {
    for (const host of [
      'orchestration-new.civitai.com',
      'orchestration-stage.civitai.com',
      'orchestration-dev.civitai.com',
      'image-generation.civitai.com',
    ]) {
      expect(isTrustedOrchestratorUrl(`https://${host}${BLOB}`), host).toBe(true);
    }
  });

  it('rejects an attacker-controlled host', () => {
    expect(isTrustedOrchestratorUrl(`https://evil.example.com${BLOB}`)).toBe(false);
  });

  it('rejects a foreign host wearing a convincing blob path', () => {
    expect(
      isTrustedOrchestratorUrl('https://evil.example.com/v2/consumer/blobs/ABC123.safetensors')
    ).toBe(false);
  });

  it('rejects the usual allowlist bypasses', () => {
    const cases = [
      // subdomain/suffix confusion
      'https://orchestration.civitai.com.evil.example.com/x',
      'https://evil-orchestration.civitai.com/x',
      // userinfo — the part before @ is not the host, but reads like it
      'https://orchestration.civitai.com@evil.example.com/x',
      // a matching name on a port we did not configure
      'https://orchestration.civitai.com:8443/x',
      'http://orchestration.civitai.com/x',
      'file:///etc/passwd',
      'https://localhost/x',
      'https://169.254.169.254/latest/meta-data/',
    ];

    for (const url of cases) {
      expect(isTrustedOrchestratorUrl(url), url).toBe(false);
    }
  });

  it('rejects an unparseable, empty or missing url rather than throwing', () => {
    expect(isTrustedOrchestratorUrl('not a url')).toBe(false);
    expect(isTrustedOrchestratorUrl('')).toBe(false);
    expect(isTrustedOrchestratorUrl(undefined)).toBe(false);
    expect(isTrustedOrchestratorUrl(null)).toBe(false);
  });

  it('still trusts the known hosts when the endpoint is unset or malformed', () => {
    setEnv({ ORCHESTRATOR_ENDPOINT: undefined });
    expect(isTrustedOrchestratorUrl(`https://orchestration-new.civitai.com${BLOB}`)).toBe(true);
    expect(isTrustedOrchestratorUrl(`https://evil.example.com${BLOB}`)).toBe(false);

    setEnv({ ORCHESTRATOR_ENDPOINT: 'not a url' });
    expect(isTrustedOrchestratorUrl(`https://orchestration-new.civitai.com${BLOB}`)).toBe(true);
    expect(isTrustedOrchestratorUrl(`https://evil.example.com${BLOB}`)).toBe(false);
  });

  it('matches the configured endpoint including its port', () => {
    setEnv({ ORCHESTRATOR_ENDPOINT: 'https://orchestration.internal.example:9000' });
    expect(isTrustedOrchestratorUrl('https://orchestration.internal.example:9000/x')).toBe(true);
    expect(isTrustedOrchestratorUrl('https://orchestration.internal.example/x')).toBe(false);
  });
});
