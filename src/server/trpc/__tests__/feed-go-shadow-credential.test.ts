/**
 * The credential description a credentialed `/api/v1/models` shadow sample carries in place of its
 * key (`~/server/trpc/feed-go-shadow-credential`): the bearer the block-scope middleware takes from
 * the Authorization header (`slice('bearer '.length).trim()`), described without the key. feed-go reads these
 * descriptions (apps/feed-go/internal/auth/rest.go, `SampleCredential*`).
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  apiCredentialDescriptor,
  blockCredentialDescriptor,
} from '~/server/trpc/feed-go-shadow-credential';

vi.hoisted(() => {
  // generateSecretHash salts with the package env's NEXTAUTH_SECRET.
  process.env.NEXTAUTH_SECRET ??= 'test-nextauth-secret';
});

const SERVICE = 'svc-token-0123456789abcdef';

/** generateSecretHash written out: SHA-512 hex of the key and the secret. */
const keyOf = (key: string) =>
  `key:${createHash('sha512')
    .update(key + process.env.NEXTAUTH_SECRET)
    .digest('hex')}`;

const req = (authorization?: string) => ({
  headers: authorization === undefined ? {} : { authorization },
});

beforeEach(() => setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE }));

describe('blockCredentialDescriptor (withBlockScope)', () => {
  it.each([
    ['no header', undefined, undefined],
    ['not a Bearer header', 'Basic eDp5', 'none'],
    ['Bearer without a space', 'Bearer', 'none'],
    ['an empty bearer', 'Bearer    ', 'none'],
    ['a key: its hash', 'Bearer k-123', keyOf('k-123')],
    ['any case of the scheme', 'bEaReR k-123', keyOf('k-123')],
    ['trimmed, not split', 'Bearer   k-123  ', keyOf('k-123')],
    ['a block JWT shape', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig', 'dotted'],
    ['a provider download token', 'Bearer github:secret', 'provider'],
    ['the orchestrator service token', `Bearer ${SERVICE}`, 'service'],
  ])('%s', (_name, header, want) => {
    expect(blockCredentialDescriptor(req(header))).toBe(want);
  });

  it('never carries the key itself', () => {
    const key = 'k-secret-value-123';
    const got = blockCredentialDescriptor(req(`Bearer ${key}`));
    expect(got).toMatch(/^key:[0-9a-f]{128}$/);
    expect(got).not.toContain(key);
  });
});

describe('apiCredentialDescriptor (readRequestBearerToken, /api/v1/images)', () => {
  it.each([
    ['no header', undefined, undefined],
    ['an empty header (the app reads ?token= then, which is never sampled)', '', undefined],
    ['no token part', 'Bearer', 'none'],
    ['an empty token part', 'Bearer  k-123', 'none'],
    ['any scheme: the second space-separated part', 'Basic k-123', keyOf('k-123')],
    ['a key: its hash', 'Bearer k-123', keyOf('k-123')],
    ['split, not trimmed: only the second part', 'Bearer k-123 extra', keyOf('k-123')],
    ['a bearer holding a dot is hashed like any key', 'Bearer a.b.c', keyOf('a.b.c')],
    ['a provider download token', 'Bearer github:secret', 'provider'],
    ['the orchestrator service token', `Bearer ${SERVICE}`, 'service'],
  ])('%s', (_name, header, want) => {
    expect(apiCredentialDescriptor(req(header))).toBe(want);
  });

  it('never carries the key itself', () => {
    const key = 'k-secret-images-123';
    const got = apiCredentialDescriptor(req(`Bearer ${key}`));
    expect(got).toMatch(/^key:[0-9a-f]{128}$/);
    expect(got).not.toContain(key);
  });
});
