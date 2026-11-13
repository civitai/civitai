import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { signReviewAccessToken } from '~/server/services/blocks/review-session';

/**
 * MOD REVIEW SANDBOX (#2831 / #2847 / #2855) — coverage for the Traefik
 * forwardAuth target /api/internal/mod-gate, an ENTRY gate with TWO arms.
 *
 * The CHIPS subresource-cookie gate was reverted: Traefik forwardAuth does not
 * forward a 2xx auth response's Set-Cookie back to the client, so the session
 * cookie could never be set (every subresource 401'd → preview never rendered).
 *
 * A request needs a valid `mr` token when EITHER arm says it is an entry request:
 *   (a) DEST arm — Sec-Fetch-Dest is document/iframe/frame/nested-document, or
 *       the header is ABSENT, EMPTY or WHITESPACE (fail-safe). Compared
 *       case-folded. All four behaviours are pinned below; the summary used to
 *       name only two of them.
 *   (b) PATH arm — the normalised X-Forwarded-Uri path is NOT a recognised static
 *       subresource path, i.e. the sandbox's static server could answer it with
 *       the SPA shell. Which HALF of that allowlist applies depends on whether the
 *       dest can create a browsing context; the path test itself does not.
 *
 *   - ENTRY + valid mr + matching host → 200 `via: 'token'` + X-Mod-Id (NO Set-Cookie)
 *   - ENTRY + missing / expired / forged / host-mismatched mr → 401
 *   - SUBRESOURCE (neither arm) → 200 `via: 'subresource'` (no token/cookie)
 *   - missing X-Forwarded-Host → 401 (fail-closed)
 *   - missing / unclassifiable X-Forwarded-Uri → ENTRY (fail-closed)
 *
 * 🔴 EVERY case asserts the DECISION — the status code, plus the `via`
 * discriminator on a 200 and the handler's own literal error string on the 401s
 * that could otherwise pass via the missing-host branch. Never the presence of a
 * substring in a path: a path-prefix guard that is merely SPELLED
 * (`startsWith('/assets/')` on the raw URI) is satisfied by the wrong string, so
 * the shell-path cases are written in shapes that normalise to the shell while
 * LOOKING like an asset.
 *
 * 🔴 WHICH CASES ARE REGRESSION COVERAGE AND WHICH ARE INVARIANT GUARDS. Measured
 * against the pre-change handler: **77 of the 153 cases go RED** there and are
 * regression coverage; the other **76 are green at base** and are INVARIANT
 * GUARDS — they pin behaviour the defect never violated and must not be counted as
 * coverage of it.
 *
 * 🔴 THE TEST FOR WHICH A CASE IS, STATED RATHER THAN LISTED. A hand-written list
 * here was wrong FOUR times — a count, a family, a fixture name that no longer
 * existed, and a clause that silently excluded the greens most central to the ✅
 * claim — because the suite kept growing and the summary did not. 🔴 RE-DERIVE THE
 * TWO NUMBERS WHENEVER A CASE IS ADDED; they have been stale three times for
 * exactly that reason. So, as a rule instead: a case is an INVARIANT GUARD exactly when the pre-change rule (entry
 * dest or absent ⇒ token, anything else ⇒ 200) already produced its expectation.
 * Everything else is regression coverage.
 *
 * 🔴 NO GLOSS ON THAT RULE. Four attempts to summarise which cases it selects were
 * each wrong — the last missed every `→ 200` case whose dest is neither an entry
 * dest nor a subresource dest, which is precisely the group most central to the ✅
 * claim. The rule above is exact and the command below is mechanical; a paraphrase
 * between them has only ever added error. Re-derive: in a THROWAWAY worktree,
 * overwrite the handler with `origin/main`'s copy, run this file, and read the two
 * numbers off the summary.
 *
 * "Invariant guard" means "not evidence about this bug", NOT "deletable" — several
 * are the only thing pinning a property. Measured, by mutating what they guard:
 * removing the structural `/assets/` half fails 6 of them; shrinking `ENTRY_DESTS`
 * to `{'document'}` fails 3; and deleting any single member of
 * `NON_DOCUMENT_DESTS` fails at least one (swept — all 18 members).
 *
 * ⚠️ WHAT THIS FILE STRUCTURALLY CANNOT SEE. Two premises the PATH arm rests on
 * live in the sandbox's static-server config, which is not in this repo: that
 * `/assets/` 404s on a miss, and that every other non-file path falls back to the
 * shell. Both were verified behaviourally against the static-server version the
 * sandbox serves with. What that probe set covers, named so the gaps are visible:
 * a doubled (and tripled) slash in front of the asset prefix still lands in the
 * asset location and 404s on a miss; a DIRECTORY under the prefix (`/assets/`,
 * `/assets/<dir>/`, `/assets/<dir>`) 404s there too, even with an `index.html`
 * present inside the asset tree — so the structural half covers directory requests
 * and not only file misses; and every fallback response is served `no-store`, so
 * allowed bytes cannot be re-read as a cached document.
 *
 * That probe set was re-run after the serving config was changed by other work,
 * and every result reproduced. Worth knowing WHY, so the next person does not
 * re-run it for no reason: what the allowlist depends on is which location answers
 * a path, what the post-rewrite URI is, and the status code — and a change to a
 * RESPONSE HEADER's value cannot move any of the three. A change to the location
 * split or to either `try_files` can, and that is the one to re-probe. No test HERE
 * can detect either happening underneath the allowlist.
 *
 * The handler is driven directly with mock req/res. The token util is REAL
 * (signed with an injected secret via process.env.NEXTAUTH_SECRET).
 */

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

import handler from '~/pages/api/internal/mod-gate';

const SECRET = 'test-nextauth-secret-bbbbbbbbbbbbbbbbbbbb';
const HOST = 'review-0123456789abcdef.civit.ai';
const MOD = 77;

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    // 🔴 Keys are NORMALISED, because the real `ServerResponse.setHeader` is
    // case-insensitive and a case-sensitive mock makes every header assertion
    // walkable by capitalisation. Measured: with a plain object store,
    // `setHeader('set-cookie', …)` passed all of the `Set-Cookie` assertions
    // below while `setHeader('Set-Cookie', …)` failed three — and the lowercase
    // form is the one that would ship the cookie in production. The reverted CHIPS
    // cookie is the reason this file exists, so that is the guard least able to
    // afford being a spelling.
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    _headers: headers,
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    _headers: Record<string, string>;
  };
}

function makeReq(opts: {
  host?: string;
  /** 🔴 `string[]` is accepted here but NO CASE USES IT, deliberately — this is not
   *  an omission to be helpfully filled in, and an earlier version of this comment
   *  wrongly claimed the array branch was pinned by it. Over HTTP/1.1, which is what
   *  the auth subrequest speaks, Node comma-joins duplicate `x-forwarded-*` headers
   *  into one STRING and arrays only `set-cookie` — so `firstHeader`'s array branch
   *  is unreachable, and a case feeding an array would assert behaviour on a shape
   *  the gate cannot receive. The REACHABLE shape is pinned instead, as a
   *  comma-joined string in both precedence orders. The handler's own `firstHeader`
   *  docblock is the authority on this; keep the two consistent. */
  uri?: string | string[];
  secFetchDest?: string;
  cookie?: string;
}): NextApiRequest {
  const headers: Record<string, string | string[]> = {};
  if (opts.host !== undefined) headers['x-forwarded-host'] = opts.host;
  if (opts.uri !== undefined) headers['x-forwarded-uri'] = opts.uri;
  if (opts.secFetchDest !== undefined) headers['sec-fetch-dest'] = opts.secFetchDest;
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  return { method: 'GET', headers } as unknown as NextApiRequest;
}

function entryUriWithToken(token: string): string {
  return `/some-slug?mr=${encodeURIComponent(token)}`;
}

describe('/api/internal/mod-gate (entry gate: dest arm OR path arm)', () => {
  const prev = process.env.NEXTAUTH_SECRET;
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prev;
    vi.clearAllMocks();
  });

  // ── ENTRY path (requires a valid mr token) ────────────────────────────────

  it('ENTRY (document) + valid mr + matching host → 200 + X-Mod-Id, NO Set-Cookie', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
    expect(res._headers['set-cookie']).toBeUndefined();
  });

  it('ENTRY (iframe) with a valid mr token → 200 + X-Mod-Id', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'iframe' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
    expect(res._headers['set-cookie']).toBeUndefined();
  });

  it('ENTRY (nested-document) with a valid mr token → 200', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'nested-document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
  });

  it('ENTRY with NO mr token → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/some-slug', secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('ENTRY with an EXPIRED mr token → 401', async () => {
    const token = signReviewAccessToken({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('ENTRY with a FORGED mr token (wrong secret) → 401', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: 'wrong-secret' });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('ENTRY with a token bound to a DIFFERENT host → 401', async () => {
    const token = signReviewAccessToken({
      modUserId: MOD,
      host: 'review-deadbeefdeadbeef.civit.ai',
      secret: SECRET,
    });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  // ── ABSENT Sec-Fetch-Dest → treated as ENTRY (fail-safe) ──────────────────

  it('ABSENT Sec-Fetch-Dest is treated as ENTRY → needs a token (401 without one)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/some-slug' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('ABSENT Sec-Fetch-Dest WITH a valid token → 200 + X-Mod-Id', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: entryUriWithToken(token) }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
    expect(res._headers['set-cookie']).toBeUndefined();
  });

  // ── SUBRESOURCE path (allowed without any token/cookie) ───────────────────
  // 🔴 POSITIVE CONTROLS. Every one of these is a request the running preview
  // makes for itself with no token (sandboxed iframe, no allow-same-origin). If
  // any of them 401s, the gate has broken every App Block in review — so these
  // are asserted as hard as the rejection cases.

  it('SUBRESOURCE (Sec-Fetch-Dest: script) → 200 (no token/cookie needed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
    expect(res._headers['set-cookie']).toBeUndefined();
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: image) → 200 (no token/cookie needed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/logo.png', secFetchDest: 'image' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: font) → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/font.woff2', secFetchDest: 'font' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: an EXTENSIONLESS file under /assets/ → 200 (the prefix half of the allowlist)', async () => {
    // /assets/ has its own location with a hard-404 fallback, so nothing under it
    // can ever be answered with the shell — membership is enough, no extension
    // needed. Without the prefix rule this 401s.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/chunkmap', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: a NON-/assets/ public/ file fetched by the block → 200', async () => {
    // Measured: blocks are served non-/assets/ `public/` paths as static files and
    // do fetch them. /assets/-only allowlisting breaks those blocks.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/public-data.json', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: a NON-/assets/ font in a nested dir → 200', async () => {
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/fonts/inter-latin.woff2', secFetchDest: 'font' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: /favicon.ico → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/favicon.ico', secFetchDest: 'image' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: a PERCENT-ENCODED asset path still resolves to /assets/ → 200', async () => {
    // The static server decodes before matching a location, so the gate must too
    // — otherwise this legitimate (if unusual) request 401s.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/%61ssets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: a PERCENT-ENCODED asset path with NO extension → 200', async () => {
    // The sibling case `/%61ssets/index.js` is vacuous: it passes on its `.js`
    // extension whether or not the path is decoded. Dropping the extension is what
    // forces the decode to be what admits it.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/%61ssets/chunkmap', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: a CACHE-BUSTED static fetch → 200 (the query is not part of the path)', async () => {
    // Routine in real blocks. Without the query strip the extension reads as
    // `json?v=2` and every parameterised static fetch in review 401s.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/data.json?v=2', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: an UPPERCASE file extension → 200 (case-folded, not rejected)', async () => {
    // Pins the extension case-fold. `/INDEX.HTML` cannot: it 401s either way.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/LOGO.PNG', secFetchDest: 'image' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('SUBRESOURCE: an UPPERCASE subresource dest is still a subresource dest → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/public-data.json', secFetchDest: 'SCRIPT' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // File types outside any hand-authored "static" list. The gate carried a closed
  // ~40-entry extension allowlist for one revision; each of these 401'd under it,
  // which would have presented to a moderator as the reviewed app being broken
  // while it worked in production. The test of a file-shaped path is now its
  // extension TOKEN, not membership of an authored set.
  const UNLISTED_STATIC_FILES: Array<[uri: string, dest: string]> = [
    ['/data.yaml', 'empty'],
    ['/captions.vtt', 'track'],
    ['/clip.mov', 'video'],
    ['/scene.obj', 'empty'],
    ['/tex.ktx2', 'empty'],
    ['/model.safetensors', 'empty'],
    // Each of these also pins one `NON_DOCUMENT_DESTS` member. Deleting that
    // member from the set is otherwise invisible: the dest-independent 401 loop
    // exercises several of them only on paths NO dest can admit, where membership
    // cannot decide the outcome.
    ['/theme.css', 'style'],
    ['/sw.js', 'serviceworker'],
    ['/app.webmanifest', 'manifest'],
    ['/chime.mp3', 'audio'],
    ['/pool.js', 'worker'],
    ['/shared.js', 'sharedworker'],
    ['/mix.js', 'audioworklet'],
    ['/paint.js', 'paintworklet'],
    ['/doc.xml', 'xslt'],
    ['/beacon.json', 'report'],
    ['/config.json', 'json'],
    // These four exist because the dest is otherwise only ever seen on an
    // /assets/ path, where the STRUCTURAL half decides and set membership cannot
    // be observed at all. script/image/font are the three highest-traffic real
    // dests, so a silent deletion would 401 most of a block's own subresources.
    ['/vendor.js', 'script'],
    ['/hero.png', 'image'],
    ['/inter.woff2', 'font'],
    ['/id.json', 'webidentity'],
    ['/notes.md', 'empty'],
  ];

  for (const [uri, dest] of UNLISTED_STATIC_FILES) {
    it(`SUBRESOURCE: a block's own ${uri} (dest ${dest}) → 200, not a hand-listed type`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: dest }), res);
      expect(res.statusCode).toBe(200);
      expect((res.body as { via?: string }).via).toBe('subresource');
    });
  }

  it('SUBRESOURCE: a subresource dest on a shell path is NOT a subresource → 401', async () => {
    // Was `/api/x` + `empty` → 200. A block host has no /api/ route: the static
    // server answers that path from its SPA fallback, i.e. with the shell. This
    // expectation changed deliberately.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/api/x', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  // ── PATH arm: a shell-reachable path needs the token under EVERY dest ──────
  // The gate is a forwardAuth target, so "requires the token" is observable only
  // as the 401 + the handler's own literal error string — asserted here so a pass
  // cannot come from some other 401 branch (e.g. the missing-host one).

  const SHELL_PATHS: Array<[label: string, uri: string]> = [
    ['the bare root', '/'],
    ['the shell by name', '/index.html'],
    ['the review entry url shape (/<slug>)', '/some-slug'],
    ['an SPA-fallback deep path', '/deep/not/an/asset'],
    ['a directory path', '/some-dir/'],
    // A trailing separator makes it a directory however file-like the last
    // segment reads; the server resolves it via index/fallback to the shell.
    ['a directory path that LOOKS like a file', '/fonts/inter.woff2/'],
    ['a nested html document', '/sub/index.html'],
    // Pins the document-extension set as a FAMILY, not just its `html` member:
    // deleting any of the other four was invisible.
    // All five members of DOCUMENT_EXTENSIONS, because dropping any single one was
    // otherwise invisible — three were covered and `xht`/`shtml` were not, which is
    // what made the "pinned as a FAMILY" claim above untrue until now.
    ['an alternate document extension', '/index.htm'],
    ['an xhtml document', '/page.xhtml'],
    ['an xht document', '/index.xht'],
    ['an shtml document', '/index.shtml'],
    // Also pins `dot <= 0` rather than `dot < 0`: `.env`'s tail would read as a
    // plausible extension token if the dot-at-zero case were admitted.
    ['a dotfile', '/.env'],
    ['a shell path dressed as an asset dir', '/assets/../index.html'],
    ['double slashes', '//index.html'],
    ['a dot segment', '/./index.html'],
    ['a percent-encoded traversal', '/%2e%2e/index.html'],
    // Pins the ROOT-ESCAPE guard specifically: with an allowlisted extension,
    // nothing else in the classifier can reject this one.
    ['a traversal above the root on a typed path', '/../x.js'],
    // Pins the /assets/ prefix's TRAILING SLASH: a sibling directory that merely
    // PREFIXES `/assets` is served by the catch-all location, so it must not
    // inherit the structural half.
    ['a sibling dir that prefixes /assets', '/assetsfoo/index.html'],
    ['an extensionless path under a dir that prefixes /assets', '/assetsfoo/chunkmap'],
    // Pins the `/.` directory clause, which the plain trailing-slash case cannot.
    ['a directory path spelled with a dot segment', '/fonts/inter.woff2/.'],
    // Pins the `/..` directory clause. Recorded because it took three attempts and
    // the two obvious fixtures kill NOTHING: `/assets/sub/..` resolves inside the
    // asset location, which 404s, so allowing it is correct; and `/x.js/..` has
    // every segment cancel, so the root return rejects it before the clause is
    // consulted. Only a path that leaves a TYPED segment behind discriminates —
    // without the clause the gate reads `a.js` as the file being named, while the
    // server answers the path from the fallback (measured: shell).
    ['a parent-directory path leaving a typed segment', '/a.js/b/..'],
    // 🔴 A `.` segment FOLLOWED BY `..`, which is the only shape that pins the dot
    // collapse for a NON-LEADING dot. Collapsing only a leading `.` leaves this as
    // `assets` + `.` + `..`, where the `..` pops the `.` instead of `assets` — so
    // the path reads as `/assets/index.html` and takes the structural half, while
    // the server resolves the same URI to the shell. Every other traversal case
    // here carries no `.` segment, so none of them can see it.
    ['a dot segment cancelled by a following parent segment', '/assets/./../index.html'],
    // Pins the extension token's own bounds: `{1,16}` — a trailing dot names
    // nothing, and an implausibly long tail is not an extension.
    ['a trailing dot', '/foo.'],
    ['a 17-character extension tail', '/foo.abcdefghijklmnopq'],
    ['an encoded separator resolving above /assets/', '/assets/..%2findex.html'],
    ['an uppercase shell name', '/INDEX.HTML'],
    ['a path-parameter suffix', '/index.html;a=b'],
  ];

  // `empty` is the decisive dest — it is what a cross-origin `fetch()` sends, and
  // it is the one that used to return 200 for every path below.
  for (const [label, uri] of SHELL_PATHS) {
    it(`PATH arm: ${label} (${uri}) with Sec-Fetch-Dest: empty and no token → 401`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: 'empty' }), res);
      expect(res.statusCode).toBe(401);
      expect((res.body as { error?: string }).error).toBe('Moderator review session required');
    });
  }

  // A SHELL-SHAPED path is rejected under EVERY subresource dest. 🔴 Not the same
  // claim as "the path arm is dest-independent", which would be false and is the
  // kind of sentence this change exists to delete: the dest decides which HALF of
  // the allowlist applies, so `/nope.js` is allowed for `empty` and rejected for
  // `object` (both pinned below). What IS dest-independent is the rejection of a
  // path that neither half can admit — no dest buys the shell.
  for (const dest of ['empty', 'image', 'style', 'object', 'embed']) {
    for (const uri of ['/', '/deep/not/an/asset']) {
      it(`PATH arm: ${uri} with Sec-Fetch-Dest: ${dest} and no token → 401 (no dest admits it)`, async () => {
        const res = makeRes();
        await handler(makeReq({ host: HOST, uri, secFetchDest: dest }), res);
        expect(res.statusCode).toBe(401);
        expect((res.body as { error?: string }).error).toBe('Moderator review session required');
      });
    }
  }

  it('PATH arm: a shell path WITH a valid mr token → 200 via token, even on a subresource dest', async () => {
    // The two arms gate; they do not deny a mod. A real moderator fetching the
    // shell with the token must still be served.
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'empty' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
  });

  // ── Dests that can create a BROWSING CONTEXT are confined to /assets/ ──────
  // The decisive pair for the ✅ claim in the handler header. `object`/`embed` are
  // not entry dests (a block's own `<object data="/assets/doc.pdf">` must keep
  // working), but they DO create a nested browsing context — so they must not be
  // able to pair with the byte residual, or the shell is loaded as a document with
  // no token. The structural `/assets/` half is the only half they get.

  const CONTEXT_CAPABLE_DESTS = ['object', 'embed', 'fencedframe', 'some-future-dest'];

  for (const dest of CONTEXT_CAPABLE_DESTS) {
    it(`CONTEXT dest ${dest}: a residual static path absent from the bundle → 401 (cannot load the shell)`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri: '/nope.js', secFetchDest: dest }), res);
      expect(res.statusCode).toBe(401);
      expect((res.body as { error?: string }).error).toBe('Moderator review session required');
    });

    it(`CONTEXT dest ${dest}: a path under /assets/ → 200 (structurally never the shell)`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri: '/assets/doc.pdf', secFetchDest: dest }), res);
      expect(res.statusCode).toBe(200);
      expect((res.body as { via?: string }).via).toBe('subresource');
    });
  }

  it('CONTEXT dest object: /assets/ must be ROOT-ANCHORED, not merely contained → 401', async () => {
    // 🔴 The edge the prefix's own comment calls fatal, and the only case that
    // pins it: a non-root-base block emits `/<base>/assets/…`, which the catch-all
    // location serves — so an absent file there is answered with the shell. A
    // `includes` instead of a `startsWith` would hand that to a dest that can
    // create a browsing context. Distinct from the trailing-slash cases below,
    // which pin a different property (verified: neither family kills the other's
    // mutant).
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/base/assets/nope.pdf', secFetchDest: 'object' }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('a non-root-base asset path gets the EXTENSION half only → 200 for a byte-only dest', async () => {
    // The other side of the same claim, which the handler states and nothing
    // tested: such a block is not locked out, it just loses the structural half.
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/base/assets/index.js', secFetchDest: 'script' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('CONTEXT dest object: a dir that merely PREFIXES /assets is not the structural half → 401', async () => {
    // Pins the trailing slash on the asset prefix in the half where it is the ONLY
    // thing that can admit a path. A prefix without it would make every
    // `/assets*` sibling directory structural, and those are served by the
    // catch-all location — i.e. can be the shell.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assetsfoo/x.js', secFetchDest: 'object' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('CONTEXT dest object: a NON-/assets/ typed file → 401 (the stated trade)', async () => {
    // A real `public/` file, but outside the half that is structurally safe — so it
    // is gated rather than served. Narrow, deliberate, and recorded here so a
    // future widening is a decision rather than a drift.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/docs/manual.pdf', secFetchDest: 'object' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('CONTEXT dest: the byte residual stays open for a dest that CANNOT load a document', async () => {
    // Same path, same absence from the bundle, different dest — this is the line
    // the two halves draw, and it is the whole reason the dest still matters.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/nope.js', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // ── header-shape fail-safes ───────────────────────────────────────────────

  it('an EMPTY Sec-Fetch-Dest is treated like an ABSENT one → entry, 401 even on an asset', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: '' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('an UPPERCASE entry dest cannot dodge the DEST arm by spelling → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: 'DOCUMENT' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  // The bound is STRADDLED EXACTLY, one char either side. A pair of loose
  // fixtures (say 1900 / 2400) is satisfied by any bound between them, so it pins
  // the existence of a bound and not its value: measured, both 1950 and 2400
  // survived such a pair, and so did `>` → `>=`.
  //
  // ⚠️ What these two CANNOT see is WHERE the check sits. The bound exists to run
  // before the allocating work, and moving it into the segment loop leaves both
  // green — ordering is not observable from a status code, so that property rests
  // on reading the handler, not on this suite.
  it('a path one char OVER the bound is not classified → 401 (fail-closed)', async () => {
    const uri = `/assets/${'a'.repeat(2049 - '/assets/'.length - 3)}.js`;
    expect(uri.length).toBe(2049);
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri, secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('a path exactly AT the bound is classified normally → 200', async () => {
    const uri = `/assets/${'a'.repeat(2048 - '/assets/'.length - 3)}.js`;
    expect(uri.length).toBe(2048);
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri, secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // 🔴 THE BOUND COVERS THE QUERY TOO, and these are the only cases that can see
  // it: a bound applied to the path alone leaves the query to be parsed by
  // `URLSearchParams` unbounded. The decision is only observable on a path the
  // gate would otherwise ALLOW — on a shell-shaped path the answer is 401 either
  // way, so such a case would pin nothing.
  it('an ALLOWED path with an over-long query is not classified → 401', async () => {
    const uri = `/assets/index.js?${'a=1&'.repeat(600)}`;
    expect(uri.length).toBeGreaterThan(2048);
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri, secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('an ALLOWED path with an ordinary query is unaffected → 200', async () => {
    // Positive control for the pair above: the bound must reject by TOTAL length,
    // not reject every request that carries a query at all.
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/assets/index.js?v=abc123', secFetchDest: 'script' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('an over-long query on a TOKEN-bearing entry request → 401 (the token is not parsed)', async () => {
    // The real point of bounding the query: `extractMrToken` must not be handed an
    // unbounded string. A valid token padded past the bound is refused rather than
    // parsed — so an over-long header cannot buy query-parsing work either.
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const uri = `/some-slug?mr=${encodeURIComponent(token)}&${'p=1&'.repeat(600)}`;
    expect(uri.length).toBeGreaterThan(2048);
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri, secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  // Pins ENTRY_DESTS MEMBERSHIP. The token-bearing entry cases above cannot: their
  // path is entry-shaped too, so the dest value never decides the outcome. On an
  // /assets/ path the PATH arm allows, so only the DEST arm can produce the 401.
  for (const dest of ['document', 'iframe', 'frame', 'nested-document']) {
    it(`DEST arm: entry dest ${dest} on an /assets/ path with no token → 401`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: dest }), res);
      expect(res.statusCode).toBe(401);
      expect((res.body as { error?: string }).error).toBe('Moderator review session required');
    });
  }

  it("X-Mod-Id carries the TOKEN's mod, not a constant", async () => {
    // Second mod id on purpose: every other case asserts against the same MOD
    // constant, so a handler that hardcoded that value would satisfy all of them.
    const otherMod = 4242;
    const token = signReviewAccessToken({ modUserId: otherMod, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['x-mod-id']).toBe(String(otherMod));
    expect(res._headers['x-mod-id']).not.toBe(String(MOD));
  });

  // ── the HOST BINDING, pinned against the suite's own constant ─────────────
  // 🔴 Every other token case sends `host: HOST`, so a handler that ignored
  // X-Forwarded-Host and verified against that one value would satisfy all of
  // them. These two use a SECOND host so the binding has to be read from the
  // request: one mod's live token must not unlock a different review host.

  const HOST2 = 'review-fedcba9876543210.civit.ai';

  it('a token minted for a SECOND host, presented to that host → 200', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST2, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST2, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
  });

  it('a token minted for HOST, presented to a DIFFERENT live host → 401', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST2, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  // ── token extraction, dest normalisation, header multiplicity ─────────────

  it('the token is read from the `mr` param by NAME, not as "the first param" → 401', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: `/some-slug?tok=${encodeURIComponent(token)}`,
        secFetchDest: 'document',
      }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('a WHITESPACE-ONLY Sec-Fetch-Dest is treated like an absent one → 401 on an asset', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: '   ' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('a PADDED subresource dest is still a subresource dest → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/public-data.json', secFetchDest: ' script ' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // 🔴 A DUPLICATED forwarded header arrives as ONE comma-joined STRING, not an
  // array — Node only arrays `set-cookie`. So the shape to pin is the string, and
  // it must be refused rather than picked from: the classifier reads a
  // concatenation fail-OPEN in BOTH halves, the structural half satisfied by a
  // leading `/assets/…` value and the extension half by a trailing `….js` one.
  // Both orders are therefore pinned. The refusal comes from the raw-character
  // check, because the join inserts a SPACE, which no real request target carries.
  //
  // ⚠️ The repo deliberately holds the opposite posture on a CLIENT-supplied
  // header: `headerValue` in `src/server/utils/client-ip.ts` refuses a multi-valued
  // header rather than picking from it, and argues that strictness in its own
  // docblock. This gate reaches the same answer by refusing the whole string.
  for (const uri of ['/index.html, /assets/index.js', '/assets/index.js, /index.html']) {
    it(`a comma-joined X-Forwarded-Uri is refused, not picked from: "${uri}" → 401`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: 'script' }), res);
      expect(res.statusCode).toBe(401);
      expect((res.body as { error?: string }).error).toBe('Moderator review session required');
    });
  }

  it('an ENTRY dest with a VALID token is still refused for a raw TAB → 401', async () => {
    // 🔴 The CHARACTER half of the raw-header check, on the ENTRY path. Its length
    // half is pinned here by the over-long-token case; the character half was
    // pinned only on subresource requests, so gating it on `!destIsEntry` left all
    // 121 cases green — while the comment states the purpose as "a header this
    // shape must not be parsed at all". A valid token is the point: nothing else in
    // the handler can produce the 401, so only the raw check can.
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: `/some-slug\t?mr=${encodeURIComponent(token)}`,
        secFetchDest: 'document',
      }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(res._headers['x-mod-gate-reason']).toBe('unclassifiable-uri');
  });

  it('a raw TAB in the forwarded URI → 401 (not a valid request target)', async () => {
    // 🔴 A TAB, not an arbitrary control byte. Node's own header parser refuses
    // 0x00-0x08, 0x0a-0x1f and 0x7f before `req.headers` exists, so a fixture using
    // one of those passes for the WRONG REASON — it pins a byte that can never
    // reach this handler, i.e. an unreachable guard. SPACE and TAB are the only
    // members of the rejected class that actually arrive; space is already covered
    // by the comma-join cases, so this is the other one.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index\t.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('legal sub-delimiter path characters straddle the check and pass → 200', async () => {
    // Straddles BOTH ends of the rejected class: `!` is 0x21, one past the top of
    // it, and `~` is 0x7e, one below DEL. Without this, widening the class by a
    // single codepoint at either end is invisible, and that widening is an
    // availability regression — both characters are legal in a path segment and
    // the server serves them.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/a!b~c.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('a PERCENT-ENCODED space is NOT a raw space → 200', async () => {
    // Positive control for the character check: it must reject raw bytes a request
    // target cannot carry, not reject the encoded form, which the server serves
    // (measured: a file whose name contains a space is served via %20).
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/my%20file.png', secFetchDest: 'image' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // ── a DECODED delimiter is refused rather than normalised ─────────────────
  // `%3F`/`%23` decode into request-target DELIMITERS, so whether such a path names
  // an asset or the shell depends on a parser this gate does not own. Measured: the
  // serving line keeps them literal and resolves all three of these to
  // `/assets/x.js`, agreeing with what the gate's normaliser would have classified
  // them as — so these cases pin a REFUSAL TO DEPEND on that agreement, not a live
  // bypass. The dest is an unrecognised one on purpose: it is the only kind
  // confined to the structural half, so it is the only kind for which the
  // classification of these paths could ever decide the outcome.
  for (const uri of [
    '/%3F/../assets/x.js',
    '/index.html%3F/../assets/x.js',
    '/%23/../assets/x.js',
  ]) {
    it(`a decoded delimiter normalising into /assets/ ("${uri}") → 401`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: 'fencedframe' }), res);
      expect(res.statusCode).toBe(401);
      expect((res.body as { error?: string }).error).toBe('Moderator review session required');
    });
  }

  // A LITERAL `#` is refused by the same check as `%23`. Before that check existed
  // both of these returned 200 — `/index.html#.js` read as a `.js` file and
  // `/#/x.js` as a typed path — while the comment claimed they were "rejected,
  // which is fail-safe". `empty` is the dest that made it reachable.
  for (const uri of ['/index.html#.js', '/#/x.js', '/assets/x.js#/../index.html']) {
    it(`a literal \`#\` in the path ("${uri}") → 401`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: 'empty' }), res);
      expect(res.statusCode).toBe(401);
      expect(res._headers['x-mod-gate-reason']).toBe('unclassifiable-uri');
    });
  }

  // S7: the query must split at the FIRST `?`. Both sites were unpinned, because a
  // single-`?` URI is identical under either direction — it takes a SECOND `?`.
  it('a second `?` is query content, not a path boundary → 200', async () => {
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/assets/x.js?a=1?b=2', secFetchDest: 'script' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('a token survives a later `?` in the query → 200 via token', async () => {
    // The same direction, at the token extractor: splitting at the last `?` drops
    // every parameter before it, `mr` included, and 401s a real moderator.
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: `/some-slug?mr=${encodeURIComponent(token)}&next=/a?b=1`,
        secFetchDest: 'document',
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('token');
    expect(res._headers['x-mod-id']).toBe(String(MOD));
  });

  it('a LITERAL `?` still separates the query, so an ordinary asset fetch is unaffected → 200', async () => {
    // Positive control for the three above: what is refused is the DECODED
    // delimiter, not querying. Without this, deleting the query split entirely
    // would leave them all green.
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/assets/x.js?a=1&b=2', secFetchDest: 'script' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // ── more spellings that reach the STRUCTURAL half ─────────────────────────
  // The asset prefix is matched on the NORMALISED path, so several shapes that do
  // not literally start with it still land there. All are allowed, and all are
  // safe for the same reason: the server resolves them the same way and answers
  // from the asset location (measured — a miss there is a 404, never the shell).
  // Pinned because they are the shapes where gate and server MUST agree. Three of
  // them are the ONLY killer of a distinct mutation (dot collapse removed, `..`
  // popping two segments, a non-leading dot failing closed); `//assets/x.js` and
  // `/x/../assets/x.js` are positive-direction coverage that other cases also
  // catch. A `///assets/x.js` case was removed as strictly dominated — no mutation
  // separates it from the doubled-slash one.
  for (const uri of [
    '//assets/x.js',
    '/./assets/x.js',
    '/x/../assets/x.js',
    '/assets/sub/../x.js',
    '/assets/./x.js',
  ]) {
    it(`STRUCTURAL half is reached by "${uri}" → 200`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: 'fencedframe' }), res);
      expect(res.statusCode).toBe(200);
      expect((res.body as { via?: string }).via).toBe('subresource');
    });
  }

  // ── fail-closed when the path cannot be classified ────────────────────────

  it('UNCLASSIFIABLE: subresource dest with NO X-Forwarded-Uri → 401 (fail-closed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  it('UNCLASSIFIABLE: a non-origin-form X-Forwarded-Uri → 401 (fail-closed)', async () => {
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: 'https://elsewhere.example/x.js', secFetchDest: 'script' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('UNCLASSIFIABLE: a malformed %-escape → 401 (fail-closed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/broken%ZZ.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('UNCLASSIFIABLE: an embedded NUL → 401 (fail-closed)', async () => {
    // Fixture deliberately ends in an ALLOWLISTED extension. The obvious spelling
    // (`/x.js%00.html`) 401s whether or not the NUL check exists, because its tail
    // is a document extension — so it pins nothing.
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/index.html%00.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Moderator review session required');
  });

  // ── the reason header: the only place a refusal is visible ────────────────
  // A subresource this gate declines surfaces no error to the moderator — the
  // element does not render, or the block silently misses a file — so these pin
  // that the 401 says WHICH check refused, and that the header is diagnostic only
  // (absent on anything allowed).

  it('a 401 from the DEST arm names that arm', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
    expect(res._headers['x-mod-gate-reason']).toBe('entry-dest');
  });

  it('a 401 from the PATH arm names that arm instead', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/deep/not/an/asset', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(401);
    expect(res._headers['x-mod-gate-reason']).toBe('shell-path');
  });

  // 🔴 An UNCLASSIFIABLE path must not be reported as a shell path. These are the
  // cases that separate the two labels: each is refused because the path could not
  // be classified at all, and the first three are literally under `/assets/` — so
  // `shell-path` there would contradict the structural rule this file states. The
  // label is deliberately the same one the raw-header checks use, because it is the
  // same answer.
  const UNCLASSIFIABLE: Array<[label: string, uri: string | undefined]> = [
    ['a percent-encoded `#` under /assets/', '/assets/a%23b.png'],
    ['a percent-encoded `?` under /assets/', '/assets/a%3Fb.png'],
    ['a bare `%` under /assets/ (a real filename shape)', '/assets/100%-off.png'],
    ['an absent X-Forwarded-Uri', undefined],
    ['an embedded NUL', '/assets/a%00b.js'],
    ['a traversal above the root', '/../x.js'],
    ['a non-origin-form URI', 'http://elsewhere.example/assets/x.js'],
  ];

  for (const [label, uri] of UNCLASSIFIABLE) {
    it(`UNCLASSIFIABLE (${label}) → 401 reason=unclassifiable-uri, not shell-path`, async () => {
      const res = makeRes();
      await handler(makeReq({ host: HOST, uri, secFetchDest: 'script' }), res);
      expect(res.statusCode).toBe(401);
      expect(res._headers['x-mod-gate-reason']).toBe('unclassifiable-uri');
    });
  }

  it('a percent-encoded `%` is NOT unclassifiable — `%25` decodes fine → 200', async () => {
    // Positive control for the three `/assets/` cases above: what is refused is a
    // malformed or delimiter-bearing escape, not every path containing a percent.
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/assets/100%25-off.png', secFetchDest: 'image' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  it('a 401 from the raw-header checks is distinguishable from both arms', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/a b.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
    expect(res._headers['x-mod-gate-reason']).toBe('unclassifiable-uri');
  });

  it('a 401 for a missing host names the host, not an arm', async () => {
    const res = makeRes();
    await handler(makeReq({ uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
    expect(res._headers['x-mod-gate-reason']).toBe('missing-host');
  });

  it('an ALLOWED request carries NO reason header', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
    expect(res._headers['x-mod-gate-reason']).toBeUndefined();
  });

  it('a TOKENED request carries no reason header either', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['x-mod-gate-reason']).toBeUndefined();
  });

  // ── the ACCEPTED RESIDUAL, pinned so it stays a decision and not a surprise ─

  it('RESIDUAL: a static-shaped path that is absent from the bundle is still allowed → 200', async () => {
    // The gate does not know the bundle's file list TODAY, and the shapes a block
    // legitimately fetches from public/ are the same shapes — so an allowlisted
    // extension that happens not to exist falls through to the SPA shell
    // unauthenticated. 🔴 "Does not know" is a statement about this gate, not an
    // impossibility: the handler header prices a lever that would close it.
    // Asserted here so a later change is deliberate rather than incidental.
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: '/definitely-not-built.js', secFetchDest: 'empty' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { via?: string }).via).toBe('subresource');
  });

  // ── fail-closed on missing host ───────────────────────────────────────────

  it('ENTRY: valid token but MISSING X-Forwarded-Host → 401 (fail-closed)', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(makeReq({ uri: entryUriWithToken(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('SUBRESOURCE: MISSING X-Forwarded-Host → 401 (fail-closed, checked before subresource allow)', async () => {
    const res = makeRes();
    await handler(makeReq({ uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
  });
});
