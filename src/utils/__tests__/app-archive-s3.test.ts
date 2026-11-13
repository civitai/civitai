import { describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { archiveStoreConfig, createArchiveStore } from '~/utils/app-archive-s3';

/**
 * Two endpoints for one bucket: the IN-CLUSTER endpoint for every call civitai makes itself (it
 * may be plain http with a port), and the PUBLIC endpoint only to presign the URLs the sandbox
 * service receives. The sandbox service accepts seeds only from https hosts with no port, so the
 * public endpoint must be one; without one nothing is presigned, never on the in-cluster endpoint.
 */

// TEST-ONLY placeholders; `.test` is a reserved TLD.
const BASE = {
  APP_ARCHIVE_S3_BUCKET: 'test-bucket',
  APP_ARCHIVE_S3_ACCESS_KEY_ID: 'test-only-key-id',
  APP_ARCHIVE_S3_SECRET_ACCESS_KEY: 'test-only-secret',
};
const IN_CLUSTER = 'http://store-direct.example.test:9000';
const PUBLIC = 'https://store-public.example.test';

function configWith(env: Record<string, string | undefined>) {
  setEnv({ ...BASE, APP_ARCHIVE_S3_PUBLIC_ENDPOINT: undefined, ...env });
  return archiveStoreConfig();
}

/** A transport that records where each request went and answers 404. */
function recordingHandler() {
  const seen: { protocol: string; hostname: string; port?: number; path: string }[] = [];
  return {
    seen,
    handler: {
      async handle(request: { protocol: string; hostname: string; port?: number; path: string }) {
        seen.push({
          protocol: request.protocol,
          hostname: request.hostname,
          port: request.port,
          path: request.path,
        });
        return { response: { statusCode: 404, headers: {}, body: undefined } };
      },
    },
  };
}

describe('archive store endpoints', () => {
  it('an http in-cluster endpoint with a port is accepted for civitai’s own calls', () => {
    expect(configWith({ APP_ARCHIVE_S3_ENDPOINT: IN_CLUSTER })).toMatchObject({
      endpoint: IN_CLUSTER,
      publicEndpoint: null,
    });
  });

  it('direct calls go to the in-cluster endpoint, never the public one', async () => {
    const config = configWith({
      APP_ARCHIVE_S3_ENDPOINT: IN_CLUSTER,
      APP_ARCHIVE_S3_PUBLIC_ENDPOINT: PUBLIC,
    })!;
    const { seen, handler } = recordingHandler();
    const store = createArchiveStore(config, { requestHandler: handler as never });
    expect(await store.head('archives/1/a/b.zip')).toBeNull();
    expect(seen).toEqual([
      {
        protocol: 'http:',
        hostname: 'store-direct.example.test',
        port: 9000,
        path: '/test-bucket/archives/1/a/b.zip',
      },
    ]);
  });

  it('presigned URLs carry the PUBLIC host (https, no port, path-style)', async () => {
    const config = configWith({
      APP_ARCHIVE_S3_ENDPOINT: IN_CLUSTER,
      APP_ARCHIVE_S3_PUBLIC_ENDPOINT: PUBLIC,
    })!;
    const store = createArchiveStore(config);
    expect(store.canPresign).toBe(true);
    const url = new URL(await store.presignPut('archives/1/a/b.zip'));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('store-public.example.test');
    expect(url.pathname).toBe('/test-bucket/archives/1/a/b.zip');
  });

  it.each([
    'http://store-public.example.test',
    'https://store-public.example.test:9000',
    'not a url',
  ])(
    'a public endpoint the sandbox service would refuse (%s) presigns nothing',
    async (publicEndpoint) => {
      const config = configWith({
        APP_ARCHIVE_S3_ENDPOINT: IN_CLUSTER,
        APP_ARCHIVE_S3_PUBLIC_ENDPOINT: publicEndpoint,
      })!;
      expect(config.publicEndpoint).toBeNull();
      const store = createArchiveStore(config);
      expect(store.canPresign).toBe(false);
      await expect(store.presignPut('archives/1/a/b.zip')).rejects.toThrow(/no public/);
    }
  );

  it('with no public endpoint, presigning refuses rather than falling back to the in-cluster one', async () => {
    const store = createArchiveStore(configWith({ APP_ARCHIVE_S3_ENDPOINT: IN_CLUSTER })!);
    expect(store.canPresign).toBe(false);
    await expect(store.presignPut('archives/1/a/b.zip')).rejects.toThrow(/no public/);
  });

  it('a store built from an unchecked public endpoint still refuses to hand out a URL the sandbox service would refuse', async () => {
    const store = createArchiveStore({
      endpoint: IN_CLUSTER,
      publicEndpoint: 'http://store-public.example.test:9000',
      bucket: 'test-bucket',
      accessKeyId: 'test-only-key-id',
      secretAccessKey: 'test-only-secret',
    });
    await expect(store.presignPut('archives/1/a/b.zip')).rejects.toThrow(/public https endpoint/);
  });

  it('no in-cluster endpoint, or one that is not http(s), is no store at all', () => {
    expect(
      configWith({ APP_ARCHIVE_S3_ENDPOINT: undefined, APP_ARCHIVE_S3_PUBLIC_ENDPOINT: PUBLIC })
    ).toBeNull();
    expect(configWith({ APP_ARCHIVE_S3_ENDPOINT: 'ftp://store-direct.example.test' })).toBeNull();
  });
});
