import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
// Imported in setup-order so the test RSA env keys are in place before
// block-token.service evaluates (same posture as block-scope.middleware.test.ts).
import '~/__tests__/setup';
import { KNOWN_STATIC_ENDPOINT_SEGMENTS, normalizeEndpoint } from '../block-scope.middleware';

/**
 * `normalizeEndpoint` writes `block_scope_invocations.endpoint`, which is the
 * GROUP BY key of the `topEndpoints` rollup in `app-analytics.service.ts`. Both
 * directions are failure modes and both are tested here:
 *
 *   - UNDER-templating fragments one logical route into N count-1 rows and the
 *     "top 5" becomes noise (the #3561 defect, for the router call sites).
 *   - OVER-templating collapses every route to the same handful of rows, which
 *     destroys the aggregate just as thoroughly and is far easier to ship
 *     unnoticed — nothing looks wrong, the panel just stops saying anything.
 *
 * The over-templating half is the reason the rule is allowlist-first: the static
 * vocabulary of these routes is slug-shaped (`generation-resources`,
 * `tip-allowance`, `shared-storage`), so a "slugs are high-cardinality" shape
 * heuristic would eat them.
 */
describe('normalizeEndpoint — templates caller-supplied segments', () => {
  it('templates a numeric id', () => {
    expect(normalizeEndpoint('/api/v1/blocks/collections/12345')).toBe(
      '/api/v1/blocks/collections/:id'
    );
  });

  it('templates a ULID, bare and prefixed', () => {
    expect(normalizeEndpoint('/api/v1/blocks/collections/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      '/api/v1/blocks/collections/:ulid'
    );
    expect(normalizeEndpoint('/api/v1/blocks/collections/apb_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      '/api/v1/blocks/collections/:ulid'
    );
  });

  it('templates a UUID in either case, bare and prefixed', () => {
    expect(
      normalizeEndpoint('/api/v1/blocks/collections/3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    ).toBe('/api/v1/blocks/collections/:uuid');
    expect(
      normalizeEndpoint('/api/v1/blocks/collections/3F2504E0-4F89-11D3-9A0C-0305E82C3301')
    ).toBe('/api/v1/blocks/collections/:uuid');
    expect(
      normalizeEndpoint('/api/v1/blocks/collections/col_3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    ).toBe('/api/v1/blocks/collections/:uuid');
  });

  it('templates a slug — the case the shape-only rule missed', () => {
    expect(normalizeEndpoint('/api/v1/blocks/collections/my-cool-collection')).toBe(
      '/api/v1/blocks/collections/:seg'
    );
  });

  it('templates a hash, a filename and percent-encoded junk', () => {
    expect(
      normalizeEndpoint('/api/v1/blocks/collections/da39a3ee5e6b4b0d3255bfef95601890afd80709')
    ).toBe('/api/v1/blocks/collections/:seg');
    expect(normalizeEndpoint('/api/v1/blocks/collections/report.json')).toBe(
      '/api/v1/blocks/collections/:seg'
    );
    expect(normalizeEndpoint('/api/v1/blocks/collections/%2e%2e%2fetc')).toBe(
      '/api/v1/blocks/collections/:seg'
    );
  });

  /**
   * The defect itself, stated as the property the column has to satisfy: distinct
   * caller values must land in ONE bucket. Asserting the templated string alone
   * would not say this — it is the collapse that makes `groupBy` work.
   */
  it('collapses distinct high-cardinality values into ONE bucket', () => {
    const bucketed = new Set(
      [
        '/api/v1/blocks/collections/my-cool-collection',
        '/api/v1/blocks/collections/another-collection',
        '/api/v1/blocks/collections/3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        '/api/v1/blocks/collections/9c858901-8a57-4791-81fe-4c455b099bc9',
        '/api/v1/blocks/collections/da39a3ee5e6b4b0d3255bfef95601890afd80709',
      ].map(normalizeEndpoint)
    );
    // Two buckets, not five: one per SHAPE (`:seg`, `:uuid`) — never one per value.
    expect([...bucketed].sort()).toEqual([
      '/api/v1/blocks/collections/:seg',
      '/api/v1/blocks/collections/:uuid',
    ]);
  });

  it('drops the query string rather than templating it', () => {
    expect(normalizeEndpoint('/api/v1/blocks/collections/12?cursor=abc&limit=24')).toBe(
      '/api/v1/blocks/collections/:id'
    );
  });
});

describe('normalizeEndpoint — leaves genuinely static segments intact', () => {
  /**
   * The real wrapped routes, with their `[id]` positions filled in. If any of
   * these loses a segment to a placeholder the panel stops distinguishing routes
   * — which is the SAME failure as not templating at all, arriving from the
   * other side.
   */
  it.each([
    ['/api/v1/blocks/me', '/api/v1/blocks/me'],
    ['/api/v1/blocks/models', '/api/v1/blocks/models'],
    ['/api/v1/blocks/images', '/api/v1/blocks/images'],
    ['/api/v1/blocks/tip', '/api/v1/blocks/tip'],
    ['/api/v1/blocks/tip-allowance', '/api/v1/blocks/tip-allowance'],
    ['/api/v1/blocks/generation-resources', '/api/v1/blocks/generation-resources'],
    ['/api/v1/blocks/collections', '/api/v1/blocks/collections'],
    ['/api/v1/blocks/collections/77', '/api/v1/blocks/collections/:id'],
    ['/api/v1/blocks/collections/77/follow', '/api/v1/blocks/collections/:id/follow'],
    ['/api/v1/blocks/shared-storage/top', '/api/v1/blocks/shared-storage/top'],
    ['/api/v1/blocks/shared-storage/increment', '/api/v1/blocks/shared-storage/increment'],
    // The six shared-storage WRITE routes. Each is listed by hand rather than
    // generated from the allowlist, so the expectation is an independent
    // statement of what the audit column should read — deriving it from
    // KNOWN_STATIC_ENDPOINT_SEGMENTS would make the assertion true by
    // construction and blind to the thing it is checking.
    ['/api/v1/blocks/shared-storage/append', '/api/v1/blocks/shared-storage/append'],
    ['/api/v1/blocks/shared-storage/update', '/api/v1/blocks/shared-storage/update'],
    ['/api/v1/blocks/shared-storage/vote', '/api/v1/blocks/shared-storage/vote'],
    ['/api/v1/blocks/shared-storage/unvote', '/api/v1/blocks/shared-storage/unvote'],
    ['/api/v1/blocks/shared-storage/withdraw', '/api/v1/blocks/shared-storage/withdraw'],
    ['/api/v1/blocks/shared-storage/report', '/api/v1/blocks/shared-storage/report'],
    // The four WORKFLOW routes, listed by hand for the same reason the six above
    // are. `workflowId` is deliberately NOT a path segment on any of them (it
    // embeds the viewer's user id — see poll.ts), so there is no `:seg` position
    // here to lose and no per-workflow value that could fragment the column.
    ['/api/v1/blocks/workflows/submit', '/api/v1/blocks/workflows/submit'],
    ['/api/v1/blocks/workflows/estimate', '/api/v1/blocks/workflows/estimate'],
    ['/api/v1/blocks/workflows/poll', '/api/v1/blocks/workflows/poll'],
    ['/api/v1/blocks/workflows/cancel', '/api/v1/blocks/workflows/cancel'],
    // The five PER-VIEWER app-storage routes, listed by hand for the same reason.
    // The `key` is deliberately NOT a path segment on any of them — it is one
    // viewer's private data and rides in the POST body (see app-storage/get.ts) —
    // so there is no `:seg` position here to lose and no per-key value that could
    // fragment the column. That is also why the under-templating half of this
    // guard matters here: `get`, `set`, `delete` and `quota` are short, generic
    // words, and without their entries in KNOWN_STATIC_ENDPOINT_SEGMENTS they
    // would each degrade to `:seg` and collapse all five routes onto ONE row
    // (`/api/v1/blocks/app-storage/:seg`), which is the over-templating failure
    // this file's docblock warns is the easy one to ship unnoticed.
    ['/api/v1/blocks/app-storage/get', '/api/v1/blocks/app-storage/get'],
    ['/api/v1/blocks/app-storage/set', '/api/v1/blocks/app-storage/set'],
    ['/api/v1/blocks/app-storage/delete', '/api/v1/blocks/app-storage/delete'],
    ['/api/v1/blocks/app-storage/list', '/api/v1/blocks/app-storage/list'],
    ['/api/v1/blocks/app-storage/quota', '/api/v1/blocks/app-storage/quota'],
    ['/api/v1/models/4201', '/api/v1/models/:id'],
  ])('%s survives as %s', (url, expected) => {
    expect(normalizeEndpoint(url)).toBe(expected);
  });

  /**
   * Called out separately because these three are the ones a shape heuristic
   * kills: they are hyphenated, multi-word and indistinguishable by shape from a
   * user-chosen slug. A rule that templates `my-cool-collection` by its hyphen
   * templates these too, and this is where that would show up.
   */
  it.each(['generation-resources', 'tip-allowance', 'shared-storage'])(
    'the slug-shaped static segment %s is NOT templated',
    (seg) => {
      expect(normalizeEndpoint(`/api/v1/blocks/${seg}`)).toBe(`/api/v1/blocks/${seg}`);
    }
  );

  it('keeps the empty segments from a leading/trailing slash', () => {
    expect(normalizeEndpoint('/api/v1/blocks/me/')).toBe('/api/v1/blocks/me/');
    expect(normalizeEndpoint('')).toBe('');
  });

  /**
   * Pins the claim the ORDER of the arms rests on. The allowlist runs before the
   * shape tests so a static segment can never be templated whatever it looks
   * like; today that ordering is behaviour-equivalent to the reverse, because no
   * static segment matches an id shape. This test is what makes that "today" a
   * checked fact — add a `/v2` or `/2024` segment and it goes red, telling you
   * the ordering has started to matter.
   */
  it('no static segment collides with an id shape (so the arm order is currently moot)', () => {
    const colliding = [...KNOWN_STATIC_ENDPOINT_SEGMENTS].filter(
      (seg) =>
        /^\d+$/.test(seg) ||
        /^[A-Za-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(seg) ||
        /^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg) ||
        /^(?:[A-Za-z]+_)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          seg
        )
    );
    expect(colliding).toEqual([]);
  });
});

/**
 * Drift guard: `KNOWN_STATIC_ENDPOINT_SEGMENTS` is only safe while it matches the
 * routes `withBlockScope` actually wraps. A route added without updating it
 * records `:seg` where a real segment belongs; an entry left behind after a route
 * is deleted silently widens the allowlist. Both are invisible to the behaviour
 * tests above, which assert against hardcoded strings.
 *
 * So derive the set from the SOURCE OF TRUTH — the route files — the way
 * `analytics-bucket-labels.drift.test.ts` greps the `recordScopeInvocation` call
 * sites rather than trusting a comment.
 */
describe('KNOWN_STATIC_ENDPOINT_SEGMENTS ⇄ withBlockScope route files drift guard', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..');
  const PAGES_API = path.join(REPO_ROOT, 'src/pages/api');

  /** Repo-relative paths under src/pages/api that `export default withBlockScope(...)`. */
  function wrappedRouteFiles(): string[] {
    const out: string[] = [];
    const walk = (abs: string) => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(child);
          // Match every extension Next treats as a page. `pageExtensions` is NOT
          // set in next.config.mjs, so the default applies: ['tsx','ts','jsx','js'].
          // Scanning only `.ts` was not hypothetical under-coverage — this repo
          // ALREADY ships `.tsx` API routes (src/pages/api/v1/vault/*.tsx), so a
          // wrapped `.tsx` route added later would have recorded every one of its
          // static segments as `:seg` with NOTHING going red. Measured: the same
          // fake wrapped route failed this guard as `.ts` and passed it as `.tsx`.
        } else if (/\.(t|j)sx?$/.test(entry.name) && !/\.test\.(t|j)sx?$/.test(entry.name)) {
          const src = readFileSync(child, 'utf8');
          // The wrap must reach the DEFAULT EXPORT — `src/pages/api/v1/me.ts`
          // merely names the middleware in a comment explaining why it is not
          // wrapped. Both spellings count: the direct
          // `export default withBlockScope(...)`, and the indirect
          // `const handler = withBlockScope(...); export default handler`, which
          // is one refactor away and was previously invisible to this walk.
          if (/export default\s+withBlockScope\(/.test(src) || /=\s*withBlockScope\(/.test(src)) {
            // A URL path, not a filesystem path: it is split on `/` below and
            // compared against `/`-separated literals, so it must not carry
            // Windows separators.
            out.push(path.relative(PAGES_API, child).replace(/\\/g, '/'));
          }
        }
      }
    };
    walk(PAGES_API);
    return out.sort();
  }

  /** The static (non-`[param]`) segments of every wrapped route's URL path. */
  function staticSegmentsFromRoutes(): string[] {
    const found = new Set<string>();
    for (const rel of wrappedRouteFiles()) {
      const route = rel.replace(/\.ts$/, '').replace(/(^|\/)index$/, '');
      for (const seg of ['api', ...route.split('/')]) {
        if (!seg || seg.startsWith('[')) continue;
        found.add(seg);
      }
    }
    return [...found].sort();
  }

  it('the walk finds the wrapped routes (positive control)', () => {
    // Without this, an fs walk that matched nothing would make the set comparison
    // below a vacuous pass on an empty set.
    const files = wrappedRouteFiles();
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files).toContain('v1/blocks/shared-storage/increment.ts');
    expect(files).toContain('v1/models/[id].ts');
  });

  it('the allowlist is EXACTLY the static segments of the wrapped routes', () => {
    expect([...KNOWN_STATIC_ENDPOINT_SEGMENTS].sort()).toEqual(staticSegmentsFromRoutes());
  });

  it('pins the current set, so adding a route is a deliberate act', () => {
    expect(staticSegmentsFromRoutes()).toEqual([
      'api',
      // `app-storage` / `get` / `set` / `delete` / `quota` — the PER-VIEWER app
      // storage surface (`v1/blocks/app-storage/*.ts`), the v1 replacement for
      // the postMessage APP_STORAGE_* bridge messages. (`list` was already in the
      // vocabulary, earned by `shared-storage/list.ts`.) Pinned for the same
      // reason as every surface below, with one extra edge: `get`, `set`,
      // `delete` and `quota` are SHORT GENERIC WORDS, so without these entries
      // `normalizeEndpoint` templates all four to `:seg` and collapses the whole
      // surface onto ONE row, `/api/v1/blocks/app-storage/:seg`. That is the
      // OVER-templating half this file's docblock calls the easy one to ship
      // unnoticed — nothing looks broken, the panel just stops saying which
      // storage operation an app performed.
      'app-storage',
      // `append` / `report` / `unvote` / `update` / `vote` / `withdraw` — the
      // shared-storage WRITE surface (`v1/blocks/shared-storage/*.ts`), the v1
      // replacement for the postMessage SHARED_* bridge writes. Six new STATIC
      // segments, pinned for the same reason the read surface's three below are:
      // without the entries `normalizeEndpoint` collapses them to a placeholder
      // and the audit log stops distinguishing a submission from a vote from a
      // deletion — on the one surface where that distinction is the point.
      //
      // ⚠️ `withdraw` is the one entry that is NOT new vocabulary:
      // `v1/blocks/withdraw.ts` has always existed. It is API-KEY authed, never
      // reaches this middleware and was never in the allowlist, so the entry is
      // earned by `shared-storage/withdraw.ts` alone — see the note on
      // KNOWN_STATIC_ENDPOINT_SEGMENTS itself.
      'append',
      'blocks',
      // `v1/blocks/buzz.ts` — the per-pool balance self-read, restored as a
      // withBlockScope REST route (it had been retired in favour of the
      // page-host bridge, which a non-page-hosted block cannot reach).
      'buzz',
      // `cancel` / `estimate` / `poll` / `submit` / `workflows` — the WORKFLOW
      // surface (`v1/blocks/workflows/*.ts`), the v1 replacement for the
      // postMessage {SUBMIT,ESTIMATE,POLL,CANCEL}_WORKFLOW bridge messages. Five
      // new STATIC segments, pinned for the same reason the shared ones are:
      // without them `normalizeEndpoint` collapses the last segment to a
      // placeholder and the audit log stops distinguishing a SPEND from a price
      // quote from a status poll — which on this surface is the only thing the
      // row would have said.
      'cancel',
      'collections',
      // `counts` / `item` / `list` — the shared-storage READ surface
      // (`v1/blocks/shared-storage/{counts,item,list}.ts`), the v1 replacement for
      // the postMessage SHARED_* bridge reads. Three new STATIC segments, so all
      // three are pinned here: without the entry, normalizeEndpoint would collapse
      // them to a placeholder and the audit log would stop distinguishing a feed
      // scan from a point read.
      'counts',
      'delete',
      'estimate',
      'follow',
      'generation-resources',
      'get',
      'images',
      'increment',
      'item',
      'list',
      'me',
      'models',
      'poll',
      'quota',
      'report',
      'set',
      'shared-storage',
      'submit',
      'tip',
      'tip-allowance',
      // The read-only chat-tool surface (#398 AC5). Added deliberately: this
      // pin is what makes a new withBlockScope route a conscious edit rather
      // than something that silently widens the audit-log segment allowlist.
      'tools',
      'top',
      'unvote',
      'update',
      // `user-checkpoint` — the per-viewer checkpoint override write
      // (`v1/blocks/user-checkpoint/set.ts`), the REST twin of the
      // SET_USER_CHECKPOINT bridge message. One new STATIC segment; `set` was
      // already in the vocabulary, earned by `app-storage/set.ts`. Pinned for the
      // OVER-templating reason this file's docblock names: without it
      // `normalizeEndpoint` yields `/api/v1/blocks/:seg/set`, so the route loses its
      // name in the `topEndpoints` rollup and `AppActivityPanel`'s label arm — an
      // exact `===` on the literal path — has no value to match, leaving the row to
      // render the raw `(any-token)` scope sentinel.
      //
      // ⚠ RETRACTED: an earlier version of this comment claimed the templated form
      // COLLIDES with `app-storage/set.ts`. It does not — `'app-storage'` is itself
      // a pinned segment (above), so that route normalises to its own literal path
      // and never to `:seg/set`. The entry is still required, for the naming reason
      // above; the collision was never the reason.
      'user-checkpoint',
      'v1',
      'vote',
      'withdraw',
      'workflows',
    ]);
  });
});
