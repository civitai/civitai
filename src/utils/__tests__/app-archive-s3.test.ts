import { describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { archiveStoreConfig, createArchiveStore } from '~/utils/app-archive-s3';

/**
 * The archive store's endpoint must be one the sandbox service will download a seed from: https,
 * no port. Anything else disables the store up front (every hibernation endpoint answers 503)
 * rather than archiving an app that could never be woken.
 */

// TEST-ONLY placeholders.
const CREDS = {
  APP_ARCHIVE_S3_BUCKET: 'test-bucket',
  APP_ARCHIVE_S3_ACCESS_KEY_ID: 'test-only-key-id',
  APP_ARCHIVE_S3_SECRET_ACCESS_KEY: 'test-only-secret',
};

describe('archiveStoreConfig', () => {
  it('accepts an https endpoint with no port', () => {
    setEnv({ ...CREDS, APP_ARCHIVE_S3_ENDPOINT: 'https://archive.example.test' });
    expect(archiveStoreConfig()).toMatchObject({ endpoint: 'https://archive.example.test' });
  });

  it.each(['http://archive.example.test', 'https://archive.example.test:9000', 'not a url'])(
    'refuses %s',
    (endpoint) => {
      setEnv({ ...CREDS, APP_ARCHIVE_S3_ENDPOINT: endpoint });
      expect(archiveStoreConfig()).toBeNull();
    }
  );

  it('a presigned URL carries the endpoint host, path-style, so the sandbox service accepts it', async () => {
    setEnv({ ...CREDS, APP_ARCHIVE_S3_ENDPOINT: 'https://archive.example.test' });
    const url = new URL(
      await createArchiveStore(archiveStoreConfig()!).presignPut('archives/1/a/b.zip')
    );
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('archive.example.test');
    expect(url.pathname).toBe('/test-bucket/archives/1/a/b.zip');
  });

  it('a store built from an unchecked config still refuses to hand out a URL the sandbox service would refuse', async () => {
    const store = createArchiveStore({
      endpoint: 'http://archive.example.test:9000',
      bucket: 'test-bucket',
      accessKeyId: 'test-only-key-id',
      secretAccessKey: 'test-only-secret',
    });
    await expect(store.presignPut('archives/1/a/b.zip')).rejects.toThrow(/https endpoint/);
  });
});
