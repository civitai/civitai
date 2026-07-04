import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_TOKEN,
  deepRedact,
  isSensitiveParam,
  redactText,
  redactUrl,
  redactValue,
} from '~/utils/faro/redact';

// Valid OTLP structural ids: traceId MUST be 32 hex, spanId/parentSpanId 16 hex. The
// Alloy faro.receiver rejects the whole beacon (HTTP 400) if any is not exactly that
// shape, so the redactor must pass them through byte-identical.
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

describe('isSensitiveParam', () => {
  it('matches sensitive names case-insensitively and as substrings', () => {
    for (const name of [
      'token',
      'CODE',
      'access_token',
      'id_token',
      'refresh_token',
      'apiKey',
      'X-Amz-Signature',
      'user_email',
      'sessionId',
      'client_secret',
      'otp',
      'verifyToken',
      'password',
    ]) {
      expect(isSensitiveParam(name)).toBe(true);
    }
  });

  it('leaves benign params alone', () => {
    for (const name of ['page', 'limit', 'sort', 'id', 'tab', 'q', 'cursor']) {
      expect(isSensitiveParam(name)).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('redacts an OAuth authorization callback (code) but keeps state', () => {
    const out = redactUrl('https://civitai.com/api/auth/callback?code=abc123SECRET&state=xyz789');
    expect(out).not.toContain('abc123SECRET');
    expect(out).toContain(`code=${REDACTED}`);
    // non-sensitive param preserved
    expect(out).toContain('state=xyz789');
  });

  it('redacts a password-reset / verify token URL (token + email)', () => {
    const out = redactUrl('/reset-password?token=super-secret-token&email=user%40example.com&next=/models');
    expect(out).not.toContain('super-secret-token');
    expect(out).not.toContain('user@example.com');
    expect(out).not.toContain('user%40example.com');
    expect(out).toContain(`token=${REDACTED}`);
    expect(out).toContain(`email=${REDACTED}`);
    // relative URL stays relative and keeps the benign param
    expect(out.startsWith('/reset-password?')).toBe(true);
    expect(out).toContain('next=%2Fmodels');
  });

  it('redacts a signed S3-style download URL (signature) but keeps the path', () => {
    const signed =
      'https://cdn.civitai.com/model-files/123/model.safetensors' +
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafef00d1234567890abcdef&X-Amz-Expires=3600';
    const out = redactUrl(signed);
    expect(out).not.toContain('deadbeefcafef00d1234567890abcdef');
    expect(out).toContain('X-Amz-Signature=' + REDACTED);
    // path + a benign param preserved
    expect(out).toContain('/model-files/123/model.safetensors');
    expect(out).toContain('X-Amz-Expires=3600');
  });

  it('redacts tokens carried in the URL fragment (OAuth implicit flow)', () => {
    const out = redactUrl('https://civitai.com/auth#access_token=xyzTOKEN123&token_type=bearer&state=ok');
    expect(out).not.toContain('xyzTOKEN123');
    expect(out).toContain('access_token=' + REDACTED);
    expect(out).toContain('state=ok');
  });

  it('leaves a clean URL unchanged (identical string, no reserialization)', () => {
    const clean = 'https://civitai.com/models/123?page=2&sort=newest';
    expect(redactUrl(clean)).toBe(clean);
  });

  it('leaves a clean relative URL unchanged', () => {
    const clean = '/models/123?page=2';
    expect(redactUrl(clean)).toBe(clean);
  });

  it('never throws on malformed input', () => {
    expect(() => redactUrl('not a url ??&&==')).not.toThrow();
    expect(redactUrl('')).toBe('');
  });
});

describe('redactText', () => {
  it('redacts an email embedded in an error message', () => {
    const out = redactText('Failed to send invite to alice.smith+promo@example.co.uk after 3 tries');
    expect(out).not.toContain('alice.smith+promo@example.co.uk');
    expect(out).toContain(REDACTED_EMAIL);
    // surrounding context preserved
    expect(out).toContain('Failed to send invite to');
    expect(out).toContain('after 3 tries');
  });

  it('redacts a JWT embedded in a stack/error string', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactText(`Auth error with bearer ${jwt} while calling /api/trpc`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).toContain('/api/trpc');
  });

  it('redacts sensitive query params inside a URL embedded in text', () => {
    const out = redactText('navigation to https://civitai.com/verify?code=SHORTCODE&ref=email failed');
    expect(out).not.toContain('SHORTCODE');
    expect(out).toContain('code=' + REDACTED);
    expect(out).toContain('ref=email');
  });

  it('leaves clean text unchanged', () => {
    const clean = 'TypeError: Cannot read properties of undefined (reading map) at Feed.render';
    expect(redactText(clean)).toBe(clean);
  });

  it('never throws on empty input', () => {
    expect(redactText('')).toBe('');
  });
});

describe('deepRedact', () => {
  it('scrubs strings recursively, using url-aware redaction for url-ish keys', () => {
    const payload = {
      message: 'login failed for bob@example.com',
      page: {
        url: 'https://civitai.com/callback?code=SECRETCODE&page=1',
        title: 'Callback',
      },
      attributes: {
        href: '/reset?token=abcdef',
        count: 3,
        nested: ['plain', 'reach me at eve@example.org'],
      },
    };
    const out = deepRedact(payload);

    expect(out.message).toContain(REDACTED_EMAIL);
    expect(out.message).not.toContain('bob@example.com');
    expect(out.page.url).toContain('code=' + REDACTED);
    expect(out.page.url).not.toContain('SECRETCODE');
    expect(out.page.url).toContain('page=1');
    expect(out.page.title).toBe('Callback');
    expect(out.attributes.href).toContain('token=' + REDACTED);
    expect(out.attributes.count).toBe(3);
    expect(out.attributes.nested[0]).toBe('plain');
    expect(out.attributes.nested[1]).toContain(REDACTED_EMAIL);
  });

  it('does not mutate the input object', () => {
    const payload = { message: 'contact carol@example.com' };
    const out = deepRedact(payload);
    expect(payload.message).toBe('contact carol@example.com');
    expect(out.message).not.toBe(payload.message);
  });

  it('handles primitives and nullish values without throwing', () => {
    expect(deepRedact(42)).toBe(42);
    expect(deepRedact(null)).toBe(null);
    expect(deepRedact(undefined)).toBe(undefined);
    expect(deepRedact(true)).toBe(true);
  });

  // F1 regression: OTLP browser-trace payloads bury `http.url` ~10 levels deep at
  // resourceSpans[].scopeSpans[].spans[].attributes[].value.stringValue. It must be
  // reachable (MAX_DEPTH) and url-aware (redactUrl), incl. span-event attributes.
  it('scrubs sensitive URLs in deeply-nested OTLP trace span + event attributes', () => {
    const otlp = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'HTTP GET',
                  attributes: [
                    { key: 'http.method', value: { stringValue: 'GET' } },
                    {
                      key: 'http.url',
                      value: {
                        stringValue:
                          'https://civitai.com/api/download?token=SUPERSECRET123&modelId=5',
                      },
                    },
                  ],
                  events: [
                    {
                      name: 'redirect',
                      attributes: [
                        {
                          key: 'location',
                          value: { stringValue: 'https://civitai.com/verify?code=EVENTCODE' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = deepRedact(otlp);
    const span = out.resourceSpans[0].scopeSpans[0].spans[0];
    const urlAttr = span.attributes[1].value.stringValue;
    expect(urlAttr).not.toContain('SUPERSECRET123');
    expect(urlAttr).toContain('token=' + REDACTED);
    expect(urlAttr).toContain('modelId=5');
    // non-sensitive attribute untouched
    expect(span.attributes[0].value.stringValue).toBe('GET');
    // span-event attribute also scrubbed
    const eventUrl = span.events[0].attributes[0].value.stringValue;
    expect(eventUrl).not.toContain('EVENTCODE');
    expect(eventUrl).toContain('code=' + REDACTED);
  });
});

// F2 regression: `page.url` (a url-key) gets the STRONGER scrub — deepRedact routes url-keys
// through `redactText(redactUrl(value))`, so an email/token/opaque-token in a URL PATH SEGMENT
// (not just a query param) is redacted on every beacon's page.url. These drive the REAL
// production path (`deepRedact` over a `{ meta: { page: { url } } }` object), NOT a local
// helper — so they actually exercise FaroProvider.scrubBeacon's routing. The bare-token case
// FAILS if url-keys are downgraded to `redactValue` (the long-token pass is what catches it).
describe('page.url path-segment scrub (real deepRedact path)', () => {
  const scrubPageUrl = (u: string): string => {
    const out = deepRedact({ meta: { page: { url: u } } }) as {
      meta: { page: { url: string } };
    };
    return out.meta.page.url;
  };

  it('redacts an email embedded in the URL path plus a sensitive query param', () => {
    const out = scrubPageUrl('https://civitai.com/u/alice@example.com/settings?token=abc123');
    expect(out).not.toContain('alice@example.com');
    expect(out).toContain(REDACTED_EMAIL);
    expect(out).toContain('token=' + REDACTED);
    expect(out).toContain('/settings');
  });

  it('redacts a JWT embedded in a URL path segment', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = scrubPageUrl(`https://civitai.com/magic/${jwt}/open`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED_TOKEN);
  });

  // Bare opaque token (no `eyJ` JWT marker, not a query param) in a PATH segment — e.g. a
  // magic-link / unsubscribe token. Only the long-token pass catches this; this asserts that
  // url-keys keep it (regression guard for the redactValue downgrade). Would FAIL without it.
  it('redacts a bare opaque long token embedded in a URL path segment', () => {
    const token = 'Xg7K2p9Qm4Rt6Vn1Bz8Ld3Fh5Jw0Cs2Ey4Ab6Nq';
    const out = scrubPageUrl(`https://civitai.com/unsubscribe/${token}/confirm`);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).toContain('/unsubscribe/');
    expect(out).toContain('/confirm');
  });

  // Residual: `location.href` percent-encodes `@` to `%40`, so an email in a
  // benign-named param slips past the literal-`@` EMAIL_RE. EMAIL_ENCODED_RE catches it.
  it('redacts a percent-encoded (%40) email in a benign-named query param', () => {
    const out = scrubPageUrl('https://civitai.com/settings?u=alice%40example.com&tab=1');
    expect(out).not.toContain('alice%40example.com');
    expect(out).toContain(REDACTED_EMAIL);
    expect(out).toContain('tab=1');
  });
});

// Residual: FaroProvider.scrubBeacon runs deepRedact over the WHOLE meta object, not just
// meta.page — so PII planted in session/view/browser attributes is caught, while stable
// identifiers (session id, user-agent, version) pass through untouched.
describe('whole-meta scrub (deepRedact over meta)', () => {
  it('redacts PII in meta.session attributes but leaves stable ids/UA/version', () => {
    const meta = {
      session: { id: 'abc123short', attributes: { note: 'contact bob@example.com' } },
      view: { name: 'default' },
      browser: { userAgent: 'Mozilla/5.0 (X11; Linux) AppleWebKit/537.36' },
      app: { name: 'civitai-dp-prod', version: '5.0.1971' },
      page: { url: 'https://civitai.com/verify?token=SECRETTOKEN' },
    };
    const out = deepRedact(meta);
    expect(out.session.attributes.note).not.toContain('bob@example.com');
    expect(out.session.attributes.note).toContain(REDACTED_EMAIL);
    // stable identifiers untouched
    expect(out.session.id).toBe('abc123short');
    expect(out.browser.userAgent).toBe('Mozilla/5.0 (X11; Linux) AppleWebKit/537.36');
    expect(out.app.version).toBe('5.0.1971');
    expect(out.view.name).toBe('default');
    // page.url still gets the url-key scrub
    expect(out.page.url).not.toContain('SECRETTOKEN');
    expect(out.page.url).toContain('token=' + REDACTED);
  });
});

// F3 regression (prod HTTP 400 on /collect): a real browser TRACE beacon carries OTLP
// structural ids — `traceId` (32 hex), `spanId`/`parentSpanId` (16 hex) — at the span AND
// span-event level. The blanket "long token-like string" heuristic matched the 32-hex
// traceId and rewrote it to `[redacted-token]`; Alloy's OTLP id parser then rejected the
// malformed id and dropped the ENTIRE beacon (logs + web-vitals + errors + traces).
// These ids MUST pass through byte-identical while genuine PII in attributes is still
// scrubbed. (This test FAILS against the pre-fix code on the traceId corruption.)
describe('OTLP trace structural-id protection (deepRedact)', () => {
  // 32-hex traceId: has both digits and letters, so the >=32-char token heuristic matched.
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const SPAN_ID = '00f067aa0ba902b7'; // 16 hex
  const PARENT_SPAN_ID = 'a3ce929d0e0e4736'; // 16 hex
  const EVENT_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'; // 32 hex
  const EVENT_SPAN_ID = 'b7ad6b7169203331'; // 16 hex

  const otlpTracePayload = () => ({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_ID,
                spanId: SPAN_ID,
                parentSpanId: PARENT_SPAN_ID,
                name: 'HTTP GET',
                attributes: [
                  {
                    key: 'http.url',
                    value: {
                      stringValue: 'https://civitai.com/api/x?code=SECRET123&state=ok',
                    },
                  },
                ],
                events: [
                  {
                    name: 'link',
                    // OTLP span events / links carry their OWN traceId/spanId.
                    traceId: EVENT_TRACE_ID,
                    spanId: EVENT_SPAN_ID,
                    attributes: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  it('leaves traceId/spanId/parentSpanId byte-identical at span + event level', () => {
    const out = deepRedact(otlpTracePayload());
    const span = out.resourceSpans[0].scopeSpans[0].spans[0];

    // Span-level ids unchanged and still valid hex length (32 / 16 / 16).
    expect(span.traceId).toBe(TRACE_ID);
    expect(span.traceId).toMatch(HEX32);
    expect(span.spanId).toBe(SPAN_ID);
    expect(span.spanId).toMatch(HEX16);
    expect(span.parentSpanId).toBe(PARENT_SPAN_ID);
    expect(span.parentSpanId).toMatch(HEX16);

    // Event-level ids unchanged and still valid hex length.
    const event = span.events[0];
    expect(event.traceId).toBe(EVENT_TRACE_ID);
    expect(event.traceId).toMatch(HEX32);
    expect(event.spanId).toBe(EVENT_SPAN_ID);
    expect(event.spanId).toMatch(HEX16);

    // None were rewritten to the redaction sentinel.
    expect(span.traceId).not.toContain(REDACTED_TOKEN);
    expect(event.traceId).not.toContain(REDACTED_TOKEN);
  });

  it('leaves span LINK ids byte-identical (the real id-bearing nested OTLP structure)', () => {
    // Real OTLP span events carry NO ids; the nested id-bearing structure is
    // spans[].links[].{traceId,spanId}. These must survive too or Alloy 400s the beacon.
    const LINK_TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 32 hex
    const LINK_SPAN_ID = '1122334455667788'; // 16 hex
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: TRACE_ID,
                  spanId: SPAN_ID,
                  links: [{ traceId: LINK_TRACE_ID, spanId: LINK_SPAN_ID, attributes: [] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = deepRedact(payload);
    const link = out.resourceSpans[0].scopeSpans[0].spans[0].links[0];
    expect(link.traceId).toBe(LINK_TRACE_ID);
    expect(link.traceId).toMatch(HEX32);
    expect(link.spanId).toBe(LINK_SPAN_ID);
    expect(link.spanId).toMatch(HEX16);
    expect(link.traceId).not.toContain(REDACTED_TOKEN);
  });

  it('still scrubs the sensitive query token in the span http.url attribute', () => {
    const out = deepRedact(otlpTracePayload());
    const url = out.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.stringValue;
    expect(url).not.toContain('SECRET123');
    expect(url).toContain('code=' + REDACTED);
    expect(url).toContain('state=ok');
  });

  it('protects snake_case OTLP id variants (trace_id/span_id/parent_span_id)', () => {
    const snake = {
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      parent_span_id: PARENT_SPAN_ID,
    };
    const out = deepRedact(snake);
    expect(out.trace_id).toBe(TRACE_ID);
    expect(out.span_id).toBe(SPAN_ID);
    expect(out.parent_span_id).toBe(PARENT_SPAN_ID);
  });

  // The fix constrains the bare long-token heuristic to url-key + free-text contexts, so an
  // arbitrary long structural value under a GENERIC (non-url, non-message) key — e.g. a
  // content hash / cache key — is no longer corrupted just for being long. (A long hex value
  // that rides under a url-key such as `stringValue` DOES still get the long-token pass; that
  // is the accepted Fix-1 tradeoff and is only cosmetic — Alloy does not format-validate
  // attribute values, only the structural ids, so it never 400s.)
  it('does not corrupt a long structural hex/hash value under a generic key', () => {
    const contentHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64 hex
    const payload = {
      cacheKey: contentHash,
      etag: contentHash,
      nested: { checksum: contentHash },
    };
    const out = deepRedact(payload);
    expect(out.cacheKey).toBe(contentHash);
    expect(out.etag).toBe(contentHash);
    expect(out.nested.checksum).toBe(contentHash);
  });
});

// The long-token heuristic must STILL fire in genuine free-text contexts (error messages,
// stack traces) so an opaque secret pasted into an error string is scrubbed — this is the
// PII protection we must NOT weaken while fixing the structural-id corruption.
describe('long-token heuristic retained for free text', () => {
  it('redactText redacts a bare opaque long token embedded in an error message', () => {
    // Opaque 40-char token (letters+digits, no vendor prefix) — triggers LONG_TOKEN_RE.
    const secret = 'Xg7K2p9Qm4Rt6Vn1Bz8Ld3Fh5Jw0Cs2Ey4Ab6Nq';
    const out = redactText(`payment call failed with key ${secret} on retry 2`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED_TOKEN);
    // surrounding prose preserved
    expect(out).toContain('payment call failed with key');
    expect(out).toContain('on retry 2');
  });

  it('deepRedact applies the long-token scrub to message/stack-trace keys', () => {
    const secret = 'Qm4Rt6Vn1Bz8Ld3Fh5Jw0Cs2Ey4Ab9Xk7Pd5Tg';
    const payload = {
      message: `boom ${secret}`,
      stacktrace: `Error: nope ${secret}\n  at foo (app.js:1:1)`,
    };
    const out = deepRedact(payload);
    expect(out.message).not.toContain(secret);
    expect(out.message).toContain(REDACTED_TOKEN);
    expect(out.stacktrace).not.toContain(secret);
    expect(out.stacktrace).toContain(REDACTED_TOKEN);
  });
});

// redactValue is the structural-leaf scrubber: URL params in embedded URLs, emails, and
// JWTs — but NOT the bare long-token heuristic (so it can't corrupt structural ids/hashes).
describe('redactValue (structural-leaf scrub)', () => {
  it('scrubs embedded URL params, emails and JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactValue('see https://civitai.com/verify?code=SECRET1 for details')).toContain(
      'code=' + REDACTED
    );
    expect(redactValue('mail bob@example.com')).toContain(REDACTED_EMAIL);
    expect(redactValue(`token ${jwt}`)).toContain(REDACTED_TOKEN);
  });

  it('leaves a bare long hex/token value UNCHANGED (no bare-token heuristic)', () => {
    const hexId = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(redactValue(hexId)).toBe(hexId);
  });
});
