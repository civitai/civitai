import { readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { humaniseScopeEndpoint, humaniseScopeInvocation } from '~/components/Apps/AppActivityPanel';
import { READ_SCOPE_LABELS } from '~/shared/constants/block-action-detail';

import { endpointBucketLabel, scopeBucketLabel } from '../analytics-bucket-labels';

/**
 * Values pinned LITERALLY, derived from the recordScopeInvocation call sites and from the
 * Activity tab's existing vocabulary — never from the implementation under test.
 */
describe('endpointBucketLabel — bounded tokens', () => {
  it.each([
    ['workflow:submit', 'Generations'],
    ['storage:set', 'App-local storage writes'],
    ['storage:delete', 'App-local storage deletes'],
    ['user-settings:write', 'Block settings saves'],
  ])('%s -> %s', (endpoint, expected) => {
    expect(endpointBucketLabel(endpoint)).toBe(expected);
  });
});

describe('endpointBucketLabel — legacy tailed buckets (no data migration was run)', () => {
  it('labels the operation and KEEPS the tail so two legacy buckets stay distinct', () => {
    expect(endpointBucketLabel('workflow:submit:wf_aaa')).toBe('Generations (wf_aaa)');
    expect(endpointBucketLabel('workflow:submit:wf_bbb')).toBe('Generations (wf_bbb)');
    // The point: distinct rows must not collapse to one identical label, which would read
    // as duplicate rows with unexplained separate counts.
    expect(endpointBucketLabel('workflow:submit:wf_aaa')).not.toBe(
      endpointBucketLabel('workflow:submit:wf_bbb')
    );
  });

  it('handles a storage key tail, including one containing colons', () => {
    expect(endpointBucketLabel('storage:set:my-key')).toBe('App-local storage writes (my-key)');
    expect(endpointBucketLabel('storage:delete:a:b')).toBe('App-local storage deletes (a:b)');
  });

  /**
   * 🔴 `pending` is a "no id captured at write time" sentinel — it never encoded STATUS.
   * Pre-#3561 the writer was `workflow:submit:${snapshot.workflowId || 'pending'}`.
   *
   * Careful about the reason: such a row genuinely might have been in flight
   * (`snapshot.status` can be 'pending' and still writes a 200), so the objection is NOT
   * "pending is factually wrong about status" — it is that reusing the word implies the
   * field carried status information, which it did not. `(no id)` asserts nothing about
   * status. The row-level humaniser carves out the same sentinel (asserted below).
   */
  it('does NOT surface the `pending` sentinel as if it were an id or a status', () => {
    expect(endpointBucketLabel('workflow:submit:pending')).toBe('Generations (no id)');
    expect(endpointBucketLabel('workflow:submit:pending')).not.toContain('pending');
  });
});

describe('endpointBucketLabel — pass-through', () => {
  it('leaves a REST path from normalizeEndpoint alone', () => {
    expect(endpointBucketLabel('/api/v1/blocks/submissions')).toBe('/api/v1/blocks/submissions');
    expect(endpointBucketLabel('/api/v1/images/:id')).toBe('/api/v1/images/:id');
  });

  it('never returns an empty string for a non-empty input', () => {
    for (const e of [
      'workflow:submit',
      'user-settings:write',
      'storage:set:k',
      '/api/v1/x',
      'zz',
    ]) {
      expect(endpointBucketLabel(e)).not.toBe('');
    }
  });

  /**
   * The label lookup must not be prototype-reachable. With a plain object index,
   * `labels['constructor']` returns a FUNCTION, the truthy check passes, and React is
   * handed a non-string child — which throws and takes out the whole panel. Not reachable
   * from any current writer (non-literal values all come from `normalizeEndpoint` and
   * contain a `/`), so this pins the type signature's honesty, not a live bug.
   */
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'returns a plain string for the prototype key %s',
    (key) => {
      expect(typeof endpointBucketLabel(key)).toBe('string');
      expect(endpointBucketLabel(key)).toBe(key);
    }
  );
});

describe('scopeBucketLabel', () => {
  it.each([
    ['ai:write:budgeted', 'AI workflow submits'],
    ['apps:storage', 'App-local storage calls'],
    ['apps:storage:shared:write', 'Shared storage writes'],
    ['collections:write:self', 'Collection updates'],
    ['(any-token)', 'Any-token routes (no scope required)'],
  ])('%s -> %s', (scope, expected) => {
    expect(scopeBucketLabel(scope)).toBe(expected);
  });

  /**
   * The two settings-write scopes are the SAME operation (`block:settings:write` is the
   * pre-#3212 name) and arrive as SEPARATE buckets with separate counts. They must not
   * share one label — two visually identical rows with different numbers is exactly what
   * the endpoint card's legacy-tail handling avoids, and the two halves of this module
   * must not hold opposite policies.
   */
  it('disambiguates the legacy settings-write scope from the current one', () => {
    expect(scopeBucketLabel('user-settings:write')).toBe('Block settings saves');
    expect(scopeBucketLabel('block:settings:write')).toBe('Block settings saves (legacy scope)');
    expect(scopeBucketLabel('user-settings:write')).not.toBe(
      scopeBucketLabel('block:settings:write')
    );
  });

  it('takes read labels from the SHARED registry, not a fourth private copy', () => {
    // Pin the identity, not merely "it changed" — a hardcoded duplicate in
    // WRITE_SCOPE_LABELS would also satisfy `not.toBe(raw)`, so that assertion could not
    // see what its comment claimed.
    expect(scopeBucketLabel('buzz:read:self')).toBe(READ_SCOPE_LABELS['buzz:read:self']);
    expect(scopeBucketLabel('user:read:self')).toBe(READ_SCOPE_LABELS['user:read:self']);
    expect(scopeBucketLabel('apps:storage:shared:read')).toBe(
      READ_SCOPE_LABELS['apps:storage:shared:read']
    );
  });

  it('passes a genuinely unmapped scope through rather than guessing', () => {
    // A shape no writer produces. (`publisher_all_my_models` would be a misleading
    // example: it is an ATTRIBUTION scope and never reaches this card at all.)
    expect(scopeBucketLabel('some:future:scope')).toBe('some:future:scope');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'returns a plain string for the prototype key %s',
    (key) => {
      expect(typeof scopeBucketLabel(key)).toBe('string');
      expect(scopeBucketLabel(key)).toBe(key);
    }
  );
});

/**
 * 🔴 WHY THE ACTIVITY PANEL'S LABELLERS ARE NOT REUSED.
 *
 * `humaniseScopeInvocation` is the genuine near-duplicate — endpoint-arm based and needs
 * no `detail` — so it is what a reader will reach for. It maps FOUR of the FIVE synthetic
 * tokens; `post:create` has no arm and returns the raw scope. See reason 3 in the source
 * module's docblock for why that count is written as a count.
 * These assertions call the REAL functions so the reasoning is verified, not restated.
 *
 * ⚠ It gained three `/api/v1/blocks/workflows/*` arms in #5068, so it is no longer true
 * that it has NO arm for a REST path — see the twin tests further down. The reasoning
 * below is unaffected: the arms it gained are exact-match, not a general REST fallback,
 * so an arbitrary REST path still falls through to the scope map.
 */
describe('the Activity panel labellers cannot serve an aggregate card', () => {
  it('humaniseScopeInvocation is the wrong REGISTER for a count column', () => {
    // A single past event, not a countable noun: "Generated an image — 245" does not read.
    expect(humaniseScopeInvocation('ai:write:budgeted', 'workflow:submit')).toBe(
      'Generated an image'
    );
    expect(endpointBucketLabel('workflow:submit')).toBe('Generations');
  });

  // Title says "an UNMAPPED REST path": #5068 gave three exact `/blocks/workflows/*`
  // paths their own arms, so the blanket claim this test used to make is no longer true.
  // The probe below is deliberately a path with no arm, which is still the common case.
  it('humaniseScopeInvocation has no arm for an UNMAPPED REST path, a large share of this card', () => {
    // Falls through to its scope→label map; with no meaningful scope that is a blank cell,
    // which is strictly worse than showing the path.
    expect(humaniseScopeInvocation('', '/api/v1/blocks/submissions')).toBe('');
    expect(endpointBucketLabel('/api/v1/blocks/submissions')).toBe('/api/v1/blocks/submissions');
  });

  /**
   * 🔴 REGRESSION (#5068 round 1, F1). The REST workflow twins are wrapped with
   * `requiredScope: 'ai:write:budgeted'`. Before the fix those three had no arm,
   * so they fell past READ_SCOPE_LABELS into SCOPE_ACTION_LABELS and every row
   * read 'Submit AI workflow' — false, on the viewer's own consent-and-spend
   * surface, and ~30x per generation at the SDK's poll cadence.
   *
   * Red at the pre-change tree with `expected 'Submit AI workflow' to be
   * 'Checked an AI workflow'`; green here.
   *
   * 🔴 THE ROUTE LIST IS READ OFF DISK, NOT HARDCODED, and that is the whole point.
   * An earlier revision of this test looped over a literal `['poll','estimate','cancel']`
   * and its docblock claimed the loop would "catch a fourth twin added later with no
   * arm". It could not: the literal named exactly the three routes the positive
   * assertions already pinned, so it was redundant and structurally blind to the case
   * it advertised — a guard reading as coverage while providing none, which is worse
   * than no guard because it stops anyone looking. Enumerating the directory is what
   * makes the claim true: add `workflows/retry.ts` with no arm and this goes red.
   */
  it('every READ-shaped REST workflow twin on disk has its own label', () => {
    const base = '/api/v1/blocks/workflows';
    // Rooted at `__dirname`, not `process.cwd()` — matching the sibling drift guard.
    // cwd depends on who spawned the runner; `__dirname` does not.
    const dir = path.resolve(__dirname, '../../../..', 'src/pages/api/v1/blocks/workflows');
    // 🔴 `/\.(t|j)sx?$/`, NOT `.ts` only. Next's `pageExtensions` is unset, so the
    // default ['tsx','ts','jsx','js'] applies and a `.tsx` API route is a real,
    // shipped shape here (`src/pages/api/v1/vault/*.tsx`). An earlier revision of
    // this guard filtered `.ts` alone: MEASURED, a `workflows/retry.tsx` twin left
    // it GREEN while the same file as `.ts` turned it red — i.e. the guard was
    // narrower than the sentence above it, which is the exact defect this test
    // exists to prevent. `.d.ts` and `.test.` are excluded because neither is a route.
    //
    // 🔴 RECURSES, because `readdirSync` is FLAT and a DIRECTORY entry carries no
    // extension. `workflows/retry/index.ts` is a real Next route at
    // `/api/v1/blocks/workflows/retry`, and a flat listing filtered it out — MEASURED
    // GREEN with that twin present, i.e. the same class of blind spot as the `.ts`-only
    // filter one revision earlier, on a different axis. The sibling guard this predicate
    // comes from (`block-scope.normalize-endpoint.test.ts`) already recurses; not
    // recursing was the divergence, not the recursion.
    // 🔴 BUILDS THE FULL RELATIVE ROUTE PATH, not the directory's own name. An earlier
    // revision returned the DIRECTORY NAME when its recursive call was non-empty, which
    // swallowed every route nested under an already-labelled directory: MEASURED,
    // `workflows/poll/history.ts` and `workflows/submit/retry.ts` both left the guard
    // GREEN, and the `submit/` case was the worst — it collapsed to `submit`, which the
    // loop below filters out, so the route was never checked at all. That is the same
    // blind-spot class as the `.ts`-only filter and the flat listing before it, on a
    // third axis. The sibling this predicate comes from builds the full relative path;
    // copying half its shape is what left the gap each time.
    // `__tests__` is excluded because both guards this is modelled on exclude it and a
    // fixture there is not a route — without it, `workflows/__tests__/helpers.ts` turned
    // the guard RED on a non-route.
    const collect = (d: string, prefix = ''): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) {
          if (e.name === '__tests__') return [];
          return collect(path.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
        }
        if (!/\.(t|j)sx?$/.test(e.name)) return [];
        if (/\.test\.(t|j)sx?$/.test(e.name) || e.name.endsWith('.d.ts')) return [];
        const stem = e.name.replace(/\.(t|j)sx?$/, '');
        // `index` names the directory itself: `retry/index.ts` → `retry`.
        const rel = stem === 'index' ? prefix : prefix ? `${prefix}/${stem}` : stem;
        return rel ? [rel] : [];
      });
    const routes = collect(dir);

    // Positive control: the enumeration actually found the routes. Without this a
    // wrong `dir` yields an empty list and every assertion below passes vacuously.
    expect(routes).toEqual(
      expect.arrayContaining(['submit', 'estimate', 'poll', 'cancel', 'query'])
    );

    expect(humaniseScopeInvocation('ai:write:budgeted', `${base}/poll`)).toBe(
      'Checked an AI workflow'
    );
    expect(humaniseScopeInvocation('ai:write:budgeted', `${base}/estimate`)).toBe(
      'Priced an AI workflow'
    );
    expect(humaniseScopeInvocation('ai:write:budgeted', `${base}/cancel`)).toBe(
      'Canceled an AI workflow'
    );
    // The app-subqueue READ. Deliberately not worded like `/poll`'s — it lists every
    // workflow the app made for this viewer, not one the app already knows about —
    // so the string is pinned in its own right rather than folded into the loop
    // below, which only asserts the label is not the WRONG one.
    expect(humaniseScopeInvocation('ai:write:budgeted', `${base}/query`)).toBe(
      'Listed AI workflows'
    );

    // `submit` is the ONE route for which the label is true — see the next test.
    for (const route of routes.filter((r) => r !== 'submit')) {
      expect(humaniseScopeInvocation('ai:write:budgeted', `${base}/${route}`)).not.toBe(
        'Submit AI workflow'
      );
    }
  });

  /**
   * The app-storage twin of the workflow guard above, enumerated off disk for the
   * same reason: a hardcoded list would name exactly the routes the positive
   * assertions already pin and would be structurally blind to a SIXTH route added
   * later with no arm.
   *
   * 🔴 THE FAILURE THIS PINS IS DIFFERENT FROM THE WORKFLOW ONE. There, a missing
   * arm produced a WRONG label ('Submit AI workflow' on a poll). Here a missing
   * arm produces NO label: `apps:storage:write` is in neither `READ_SCOPE_LABELS`
   * nor `SCOPE_ACTION_LABELS`, so `humaniseScopeInvocation` falls all the way
   * through its ladder and renders the RAW SCOPE STRING `apps:storage:write` into
   * the viewer's activity feed. Watched RED at `origin/main` + the routes without
   * the two `AppActivityPanel` arms; green with them.
   */
  it('every app-storage REST route on disk renders a real label, never a raw scope', () => {
    const base = '/api/v1/blocks/app-storage';
    // Same predicate as the workflow guard above — rooted at `__dirname`,
    // recursive, `/\.(t|j)sx?$/`, `__tests__` excluded. See its docblock for why
    // each of those three is load-bearing; copying half its shape is what left a
    // gap there three revisions running.
    const dir = path.resolve(__dirname, '../../../..', 'src/pages/api/v1/blocks/app-storage');
    const collect = (d: string, prefix = ''): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) {
          if (e.name === '__tests__') return [];
          return collect(path.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
        }
        if (!/\.(t|j)sx?$/.test(e.name)) return [];
        if (/\.test\.(t|j)sx?$/.test(e.name) || e.name.endsWith('.d.ts')) return [];
        const stem = e.name.replace(/\.(t|j)sx?$/, '');
        const rel = stem === 'index' ? prefix : prefix ? `${prefix}/${stem}` : stem;
        return rel ? [rel] : [];
      });
    const routes = collect(dir);

    // Positive control: the enumeration actually found the routes. Without this a
    // wrong `dir` yields an empty list and every assertion below passes vacuously.
    expect(routes).toEqual(expect.arrayContaining(['get', 'set', 'delete', 'list', 'quota']));

    // The WRITE pair carries `apps:storage:write`, which has no map entry — so
    // without an arm each of these IS the raw scope string.
    const WRITE_ROUTES = new Set(['set', 'delete']);
    for (const route of routes) {
      const scope = WRITE_ROUTES.has(route) ? 'apps:storage:write' : 'apps:storage:read';
      const label = humaniseScopeInvocation(scope, `${base}/${route}`);
      expect(label, `${route} renders its own scope string as a label`).not.toBe(scope);
      expect(label.startsWith('apps:storage'), `${route} leaked a scope-shaped label`).toBe(false);
    }

    // The exact labels, so this is a contract and not merely "something non-empty".
    expect(humaniseScopeInvocation('apps:storage:write', `${base}/set`)).toBe(
      'Wrote app-local storage (API)'
    );
    expect(humaniseScopeInvocation('apps:storage:write', `${base}/delete`)).toBe(
      'Deleted app-local storage (API)'
    );
    // The three READS need NO arm — `apps:storage:read` IS in READ_SCOPE_LABELS,
    // and that label is true for all three. Pinning it here is what stops someone
    // "completing the set" with three redundant arms, and what makes the absence
    // of those arms a decision rather than an omission.
    for (const route of ['get', 'list', 'quota']) {
      expect(humaniseScopeInvocation('apps:storage:read', `${base}/${route}`)).toBe(
        'Read your app storage'
      );
    }

    // 🔴 The two WRITE labels must NOT equal the labels the shared body's OWN
    // activity row renders ('Wrote app-local storage' / 'Deleted app-local
    // storage'). A REST write emits BOTH rows, so identical text would render one
    // action as two identical entries — the specific noise the '(API)' suffix
    // exists to prevent. This is the assertion that fails if someone "tidies" the
    // suffix away.
    expect(humaniseScopeInvocation('apps:storage:write', `${base}/set`)).not.toBe(
      humaniseScopeInvocation('apps:storage:write', 'storage:set')
    );
    expect(humaniseScopeInvocation('apps:storage:write', `${base}/delete`)).not.toBe(
      humaniseScopeInvocation('apps:storage:write', 'storage:delete')
    );
  });

  it('but /workflows/submit still DOES — that label is true for that one route', () => {
    // Pins the deliberate asymmetry so a later reader does not "complete the set"
    // by adding a submit arm and silently relabel a real submission.
    expect(humaniseScopeInvocation('ai:write:budgeted', '/api/v1/blocks/workflows/submit')).toBe(
      'Submit AI workflow'
    );
  });

  /**
   * 🔴 PINS THE FOUR-OF-FIVE COUNT the docblock above and reason 3 in the source module
   * both assert. Until now nothing did: the docblock said "These assertions call the REAL
   * functions so the reasoning is verified, not restated" while `post:create` appeared in
   * no assertion in either label file — so adding a `post:create` arm (plausible, since
   * reason 3 reads like a TODO) would have falsified two comments with nothing going red.
   * A sixth TOKEN is already guarded by `analytics-bucket-labels.drift.test.ts`; the ARM
   * COUNT was the unguarded half.
   */
  it('post:create is the FIFTH synthetic token and has NO arm — it returns the raw scope', () => {
    // `posts:write:self` is in neither label map, so the scope falls all the way through.
    expect(humaniseScopeInvocation('posts:write:self', 'post:create')).toBe('posts:write:self');
    // Contrast: the four that DO have arms, so this pins a count and not just one miss.
    expect(humaniseScopeInvocation('ai:write:budgeted', 'workflow:submit')).toBe(
      'Generated an image'
    );
    expect(humaniseScopeInvocation('block:settings:write', 'user-settings:write')).toBe(
      'Saved your block settings'
    );
    expect(humaniseScopeInvocation('apps:storage:write', 'storage:set')).toBe(
      'Wrote app-local storage'
    );
    expect(humaniseScopeInvocation('apps:storage:write', 'storage:delete')).toBe(
      'Deleted app-local storage'
    );
  });

  it('humaniseScopeEndpoint resolves a per-ROW id an aggregate bucket does not have', () => {
    expect(humaniseScopeEndpoint('workflow:submit')).toBe('(no workflow id)');
    expect(humaniseScopeEndpoint('user-settings:write')).toBe('');
  });

  it('humaniseScopeInvocation had the SAME prototype hazard, now guarded too', () => {
    // It shares READ_SCOPE_LABELS with us, and `??` does not reject a non-nullish
    // prototype hit — this used to return Object.prototype.constructor (a function).
    for (const key of ['constructor', 'toString', 'valueOf']) {
      expect(typeof humaniseScopeInvocation(key)).toBe('string');
      expect(humaniseScopeInvocation(key)).toBe(key);
    }
  });

  it('and it agrees with us that `pending` is not an id', () => {
    // The shared premise behind our `(no id)` label — if this ever changes, revisit both.
    expect(humaniseScopeEndpoint('workflow:submit:pending')).toBe('(no workflow id)');
  });
});
