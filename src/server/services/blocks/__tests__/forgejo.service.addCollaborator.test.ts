import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `addCollaborator` grant-AT-LEAST semantics.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The bare PUT this replaced was a SET, not a grant. Two call sites in
 * blocks.router.ts ask for different levels — `getMyAppRepo` (web/push) asks for
 * `write`, `getMyForgejoCloneInfo` (the CLI `civitai app pull`) asks for `read` —
 * so an author who had push access via the web and then ran `app pull` was
 * silently downgraded to read on their own repository. Nothing reported it: the
 * downgrade answers `204 No Content`, byte-identically to a real grant.
 *
 * THE FAKE IS BUILT FROM MEASUREMENT, NOT FROM THE IMPLEMENTATION
 * ---------------------------------------------------------------
 * Every behaviour `makeForgejo` reproduces was observed against a throwaway
 * `codeberg.org/forgejo/forgejo:15.0.6` container — the version the deployed
 * instance reports (`GET /api/v1/version` → `15.0.6+gitea-1.22.0`). Observed:
 *   - `GET …/collaborators/{user}/permission` → 200
 *     `{permission, role_name, user}`; on a PRIVATE repo a NON-collaborator
 *     reads back `permission: "none"` (200, NOT 404). A nonexistent user or repo
 *     is a 404. An org owner reads back `owner`, and still reads `owner` after
 *     being added as a collaborator.
 *   - `PUT …/collaborators/{user}` → **204 for all four of** first grant,
 *     same-level re-grant, upgrade, and DOWNGRADE. A read-back confirms the
 *     downgrade landed. No status code distinguishes them, so the old
 *     `res.status !== 422` check could not have caught this. `admin` → `write`
 *     is a downgrade too.
 *   - A PUT body naming an unrecognised permission is a no-op (204, level
 *     unchanged); `owner` is not grantable that way either; and the match is
 *     case-SENSITIVE, so an uppercase `WRITE` is likewise a no-op.
 *   - With the `write:repository` PAT this flow mints: no collaborator row →
 *     clone FAILS; `read` → clone OK but push REJECTED; `write` → both OK.
 *     That is why a skipped grant would deny access outright, and why the
 *     downgrade genuinely broke authors' pushes.
 * `TestHarnessControls` below pins that the fake still reproduces the downgrade
 * — without that, every "the permission survived" assertion here would pass
 * vacuously against a fake that simply cannot lower anything.
 */

vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok-test',
    FORGEJO_WEBHOOK_SECRET: 'sec-test',
    APPS_DOMAIN: 'civit.ai',
    FORGEJO_API_TIMEOUT_MS: 15000,
    FORGEJO_COMMIT_TIMEOUT_MS: 120000,
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(() => Promise.resolve()),
}));

import { logToAxiom } from '~/server/logging/client';

const ORG = 'civitai-apps';
const SLUG = 'gen-matrix';
const USER = 'dev-7';

/** Levels a PUT can actually apply — measured; anything else is a no-op. */
const APPLICABLE = new Set(['read', 'write', 'admin']);

/**
 * State is keyed by `repo/user`, NOT by user alone. That is not tidiness: a fake
 * that ignores the repo segment cannot tell the real endpoint from one pointed
 * at a DIFFERENT repo, and a mutant that reads some other repo's permission
 * then survives the whole suite. Keying on the pair makes the wrong-repo read
 * return that repo's answer — which is exactly what production would do — so the
 * downgrade lands and the regression test sees it.
 */
function makeForgejo(initial: Record<string, string> = {}, repo: string = SLUG) {
  const state = new Map<string, string>(
    Object.entries(initial).map(([user, level]) => [`${repo}/${user}`, level])
  );
  const puts: Array<{ repo: string; user: string; permission: unknown }> = [];
  const reads: Array<{ repo: string; user: string }> = [];
  let readOverride: null | (() => Response | Promise<Response>) = null;
  let putStatus = 204;

  const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    const perm = new RegExp(`/repos/${ORG}/([^/]+)/collaborators/([^/]+)/permission$`).exec(u);
    if (perm) {
      const readRepo = decodeURIComponent(perm[1]);
      const user = decodeURIComponent(perm[2]);
      reads.push({ repo: readRepo, user });
      if (readOverride) return readOverride();
      const level = state.get(`${readRepo}/${user}`) ?? 'none';
      return new Response(
        JSON.stringify({ permission: level, role_name: level, user: { login: user } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const collab = new RegExp(`/repos/${ORG}/([^/]+)/collaborators/([^/]+)$`).exec(u);
    if (collab && init?.method === 'PUT') {
      const putRepo = decodeURIComponent(collab[1]);
      const user = decodeURIComponent(collab[2]);
      const body = JSON.parse(String(init.body ?? '{}')) as { permission?: unknown };
      puts.push({ repo: putRepo, user, permission: body.permission });
      if (putStatus >= 200 && putStatus < 300) {
        // The measured behaviour the service has to defend against: Forgejo
        // SETS the level in BOTH directions.
        if (typeof body.permission === 'string' && APPLICABLE.has(body.permission)) {
          state.set(`${putRepo}/${user}`, body.permission);
        }
      }
      return new Response(null, { status: putStatus });
    }
    throw new Error(`fake forgejo: unexpected ${init?.method ?? 'GET'} ${u}`);
  });

  return {
    fetch: fetchMock,
    puts,
    reads,
    effective: (user: string, onRepo: string = repo) => state.get(`${onRepo}/${user}`) ?? 'none',
    rawPut: (user: string, permission: string) =>
      fetchMock(`https://forgejo.example/api/v1/repos/${ORG}/${repo}/collaborators/${user}`, {
        method: 'PUT',
        body: JSON.stringify({ permission }),
      }),
    failReadWith: (status: number, body = '{}') => {
      readOverride = () => new Response(body, { status });
    },
    readReturns: (body: string) => {
      readOverride = () =>
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    readThrows: (message: string) => {
      readOverride = () => {
        throw new Error(message);
      };
    },
    setPutStatus: (s: number) => {
      putStatus = s;
    },
  };
}

type Forgejo = ReturnType<typeof makeForgejo>;

function install(fj: Forgejo) {
  vi.stubGlobal('fetch', fj.fetch);
}

async function svc() {
  return import('../forgejo.service');
}

beforeEach(() => {
  vi.mocked(logToAxiom).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TestHarnessControls', () => {
  it('POSITIVE CONTROL: the fake records a PUT and applies it, so a 0-PUT assertion means something', async () => {
    const fj = makeForgejo();
    await fj.rawPut(USER, 'write');
    expect(fj.puts).toHaveLength(1);
    expect(fj.effective(USER)).toBe('write');
  });

  it('KNOWN-BAD CONTROL: the fake reproduces the measured DOWNGRADE — a raw PUT of read lowers write', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    const res = await fj.rawPut(USER, 'read');
    // The status a real downgrade returns — indistinguishable from a grant.
    expect(res.status).toBe(204);
    expect(fj.effective(USER)).toBe('read');
  });
});

describe('addCollaborator — never lowers an existing permission', () => {
  it('THE REGRESSION: write (web/push) then read (civitai app pull) leaves the author at write', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

    expect(fj.effective(USER)).toBe('write');
    expect(result).toEqual({ requested: 'read', existing: 'write', outcome: 'kept' });
    expect(fj.puts).toHaveLength(0);
  });

  it('the whole two-call-site sequence: grant write, then the CLI pull grant, then read back', async () => {
    const fj = makeForgejo();
    install(fj);
    const { addCollaborator } = await svc();

    await addCollaborator({ slug: SLUG, username: USER, permission: 'write' });
    expect(fj.effective(USER)).toBe('write');

    await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });
    expect(fj.effective(USER)).toBe('write');

    // Exactly one PUT across both calls — the second was skipped, not re-applied.
    expect(fj.puts).toEqual([{ repo: SLUG, user: USER, permission: 'write' }]);
  });

  it.each(['read', 'write'] as const)(
    'never lowers an existing admin, for either call site level (%s)',
    async (permission) => {
      const fj = makeForgejo({ [USER]: 'admin' });
      install(fj);
      const { addCollaborator } = await svc();

      const result = await addCollaborator({ slug: SLUG, username: USER, permission });

      expect(fj.effective(USER)).toBe('admin');
      expect(result.outcome).toBe('kept');
      expect(fj.puts).toHaveLength(0);
    }
  );

  it.each(['read', 'write'] as const)(
    'never lowers an org owner, for either call site level (%s)',
    async (permission) => {
      const fj = makeForgejo({ [USER]: 'owner' });
      install(fj);
      const { addCollaborator } = await svc();

      const result = await addCollaborator({ slug: SLUG, username: USER, permission });

      expect(fj.effective(USER)).toBe('owner');
      expect(result).toEqual({ requested: permission, existing: 'owner', outcome: 'kept' });
      expect(fj.puts).toHaveLength(0);
    }
  );

  it('logs the refusal, so a prevented downgrade is visible in production', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    install(fj);
    const { addCollaborator } = await svc();

    await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
      name: 'forgejo-add-collaborator',
      message: 'kept higher existing permission',
      slug: SLUG,
      username: USER,
      requested: 'read',
      existing: 'write',
    });
  });

  it('a same-level re-grant is a no-op and is NOT logged as a refusal', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'write' });

    expect(result.outcome).toBe('kept');
    expect(fj.puts).toHaveLength(0);
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});

describe('addCollaborator — grants that SHOULD go out still go out', () => {
  it('a user who is not yet a collaborator (reads back "none") gets the grant', async () => {
    const fj = makeForgejo();
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

    expect(fj.effective(USER)).toBe('read');
    expect(result).toEqual({ requested: 'read', existing: 'none', outcome: 'granted' });
    expect(fj.puts).toEqual([{ repo: SLUG, user: USER, permission: 'read' }]);
  });

  it('upgrades read → write', async () => {
    const fj = makeForgejo({ [USER]: 'read' });
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'write' });

    expect(fj.effective(USER)).toBe('write');
    expect(result).toEqual({ requested: 'write', existing: 'read', outcome: 'granted' });
  });

  it('defaults to write when no permission is passed', async () => {
    const fj = makeForgejo();
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER });

    expect(result.requested).toBe('write');
    expect(fj.puts).toEqual([{ repo: SLUG, user: USER, permission: 'write' }]);
  });

  /**
   * The FULL URL, not just the trailing segments. A `toContain` on
   * `/collaborators/<user>/permission` cannot see which REPO is being read, and
   * a read pointed at the wrong repo is not a cosmetic bug: it either reports
   * some other repo's level and skips a grant the author actually needed, or
   * reports `none` and lets the downgrade through. Both hops are asserted
   * whole, so the org and slug segments are pinned too.
   */
  it('addresses the RIGHT repo on both hops, and URL-encodes the username', async () => {
    const fj = makeForgejo();
    install(fj);
    const { addCollaborator } = await svc();

    await addCollaborator({ slug: SLUG, username: 'dev user+1', permission: 'write' });

    const urls = fj.fetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      `https://forgejo.example/api/v1/repos/${ORG}/${SLUG}/collaborators/dev%20user%2B1/permission`,
      `https://forgejo.example/api/v1/repos/${ORG}/${SLUG}/collaborators/dev%20user%2B1`,
    ]);
  });

  it('reads the permission for the SAME (repo, user) pair it is about to grant on', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    install(fj);
    const { addCollaborator } = await svc();

    await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

    expect(fj.reads).toEqual([{ repo: SLUG, user: USER }]);
  });
});

describe('addCollaborator — the ranking table itself', () => {
  /**
   * `permissionRank` deliberately uses `hasOwnProperty` rather than `in`. With
   * `in`, an inherited Object.prototype key would "rank" as a FUNCTION, and the
   * `>=` comparison against a number is then always false — silently turning a
   * junk permission string into a grant that proceeds while claiming it was
   * observed. Unreachable through today's Forgejo, pinned so the cheaper
   * spelling cannot be swapped in without a test going red.
   */
  it.each(['toString', 'constructor', 'valueOf', '__proto__'])(
    'treats the inherited Object key %s as unrankable, not as a permission',
    async (inherited) => {
      const fj = makeForgejo({ [USER]: 'write' });
      fj.readReturns(JSON.stringify({ permission: inherited }));
      install(fj);
      const { addCollaborator } = await svc();

      const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

      expect(result.outcome).toBe('granted-unobserved');
      expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
        type: 'warning',
        reason: `unrankable "${inherited}"`,
      });
    }
  );
});

describe('addCollaborator — unobservable reads fail toward ACCESS, loudly', () => {
  it('a failing read still grants, and says so in the result and the log', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    fj.failReadWith(500, 'boom');
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

    expect(result).toEqual({ requested: 'read', existing: null, outcome: 'granted-unobserved' });
    expect(fj.puts).toEqual([{ repo: SLUG, user: USER, permission: 'read' }]);
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
      name: 'forgejo-add-collaborator',
      type: 'warning',
      message: 'granting without observing the current permission',
      reason: 'HTTP 500',
    });
  });

  it('a 404 read (nonexistent user or repo — measured) is unobservable, not "none"', async () => {
    const fj = makeForgejo();
    fj.failReadWith(404, '{"message":"user does not exist"}');
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'write' });

    expect(result.outcome).toBe('granted-unobserved');
    expect(result.existing).toBeNull();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('an UNRANKABLE permission string is not silently treated as "none"', async () => {
    const fj = makeForgejo({ [USER]: 'write' });
    fj.readReturns(JSON.stringify({ permission: 'maintainer' }));
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'read' });

    expect(result.outcome).toBe('granted-unobserved');
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
      type: 'warning',
      reason: 'unrankable "maintainer"',
    });
  });

  it('a read whose body has no permission field is unobservable', async () => {
    const fj = makeForgejo();
    fj.readReturns(JSON.stringify({ role_name: 'write' }));
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'write' });

    expect(result.outcome).toBe('granted-unobserved');
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
      reason: 'no permission field',
    });
  });

  it('a read that THROWS (network/abort) is unobservable and does not propagate', async () => {
    const fj = makeForgejo();
    fj.readThrows('fetch failed');
    install(fj);
    const { addCollaborator } = await svc();

    const result = await addCollaborator({ slug: SLUG, username: USER, permission: 'write' });

    expect(result.outcome).toBe('granted-unobserved');
    expect(fj.puts).toHaveLength(1);
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({ reason: 'fetch failed' });
  });
});

describe('addCollaborator — PUT error paths', () => {
  it('throws with the status and body when the grant fails', async () => {
    const fj = makeForgejo();
    fj.setPutStatus(403);
    install(fj);
    const { addCollaborator } = await svc();

    await expect(
      addCollaborator({ slug: SLUG, username: USER, permission: 'write' })
    ).rejects.toThrow(/Forgejo addCollaborator 403/);
  });

  it('tolerates a 422 rather than throwing', async () => {
    const fj = makeForgejo();
    fj.setPutStatus(422);
    install(fj);
    const { addCollaborator } = await svc();

    await expect(
      addCollaborator({ slug: SLUG, username: USER, permission: 'write' })
    ).resolves.toMatchObject({ outcome: 'granted' });
  });
});
