import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';
import { isClusterLocalServiceUrl } from '~/env/cluster-local-url';

// APP_DATA_SHADOW_URL receives every shadowed request's own bearer token, so only http(s) to a
// cluster-local service host is taken (app-data-go's rule for the URLs it sends tokens to).
// Anything else reads as unset (the shadow stays off) and never fails the env parse.
const field = serverSchema.shape.APP_DATA_SHADOW_URL;

const ACCEPTED = [
  'http://shadow-target.ns-a.svc:8080',
  'http://shadow-target.ns-a.svc',
  'https://shadow-target.ns-b.svc.cluster.local:8443/base/',
  'http://SHADOW-TARGET.NS-A.SVC.CLUSTER.LOCAL.',
];
const REFUSED = [
  '',
  'not a url',
  'https://shadow-target.example.com',
  'http://shadow-target.svc.example.com',
  'http://svc',
  'ftp://shadow-target.ns-a.svc',
  'http://user:pw@shadow-target.ns-a.svc',
  'http://shadow-target.ns-a.svc/?q=1',
  'http://shadow-target.ns-a.svc/#frag',
];

describe('APP_DATA_SHADOW_URL: cluster-local http(s) only, fail-soft', () => {
  it('takes an http(s) URL to a *.svc or *.svc.cluster.local host as given', () => {
    for (const raw of ACCEPTED) {
      expect(isClusterLocalServiceUrl(raw), raw).toBe(true);
      expect(field.parse(raw), raw).toBe(raw);
    }
  });

  it('reads anything else as unset, without throwing', () => {
    for (const raw of REFUSED) {
      expect(isClusterLocalServiceUrl(raw), raw).toBe(false);
      expect(() => field.parse(raw)).not.toThrow();
      expect(field.parse(raw), raw).toBeUndefined();
    }
    expect(field.parse(undefined)).toBeUndefined();
  });
});
