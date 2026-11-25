import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';
import { isPlainHttpsUrl } from '~/env/plain-https-url';

// APP_DATA_SERVICE_PUBLIC_URL is sent to app frames as BLOCK_INIT.appData.url, which the SDK reads
// as absent unless it is plain https with no credentials, query or fragment. Anything else reads
// as unset here (so it is never sent) and never fails the env parse.
const field = serverSchema.shape.APP_DATA_SERVICE_PUBLIC_URL;

const ACCEPTED = [
  'https://records.example.test',
  'https://records.example.test/',
  'https://records.example.test:8443/base/',
];
const REFUSED = [
  '',
  'not a url',
  'http://records.example.test',
  'ftp://records.example.test',
  'https://user:pw@records.example.test',
  'https://user@records.example.test',
  'https://records.example.test/?q=1',
  'https://records.example.test/?',
  'https://records.example.test/#frag',
  'https://records.example.test/#',
];

describe('APP_DATA_SERVICE_PUBLIC_URL: plain https only, fail-soft', () => {
  it('takes a plain https URL as given', () => {
    for (const raw of ACCEPTED) {
      expect(isPlainHttpsUrl(raw), raw).toBe(true);
      expect(field.parse(raw), raw).toBe(raw);
    }
  });

  it('reads anything else as unset, without throwing', () => {
    for (const raw of REFUSED) {
      expect(isPlainHttpsUrl(raw), raw).toBe(false);
      expect(() => field.parse(raw)).not.toThrow();
      expect(field.parse(raw), raw).toBeUndefined();
    }
    expect(field.parse(undefined)).toBeUndefined();
  });
});
