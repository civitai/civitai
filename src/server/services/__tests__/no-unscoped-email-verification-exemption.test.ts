import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — the two ways out of the email-verification gate, both of which are one edit wide.
 *
 * The gate lives on `guardedProcedure`, so a new content mutation inherits it without anyone
 * remembering to. That property survives only while the ways around it stay visible:
 *
 *   1. Swap the procedure for `guardedProcedureAllowUnverifiedEmail` — the documented exemption.
 *   2. Swap it for `protectedProcedure` — cheaper still, and it drops the MUTE and ONBOARDING checks
 *      with it. This is the one an adversarial review found unguarded: `post.create` downgraded to
 *      `protectedProcedure` left the whole suite green.
 *
 * Neither is forbidden. Doing either WITHOUT saying so here is what this stops.
 */

const ROUTERS = path.resolve(__dirname, '../../../../src/server/routers');
const TRPC = path.resolve(__dirname, '../../../../src/server/trpc.ts');
const EXEMPT = 'guardedProcedureAllowUnverifiedEmail';

/** file → the procedures allowed to use the exemption, and why. */
const ALLOWLIST: Record<string, { procedures: string[]; why: string }> = {
  'report.router.ts': {
    procedures: ['create', 'createAppeal'],
    why: 'Reporting abuse, and appealing your own restriction, are never gated.',
  },
  'games.router.ts': {
    procedures: ['getPlayer', 'getImagesQueue', 'getHistory'],
    why: 'Queries the New Order UI renders from — a refusal blanks the page.',
  },
  'feedback.router.ts': {
    procedures: ['getArea', 'create'],
    why: 'Both, together: the router already requires that whoever sees the prompt can submit.',
  },
  'user.router.ts': {
    procedures: ['updateBrowsingMode'],
    why: 'A browsing preference, not a content action.',
  },
};

/**
 * A sample of the surfaces the gate exists for. Not exhaustive — an exhaustive list would be the
 * hand-enumeration this guard is meant to survive — but every one of these is public content, so a
 * downgrade of any of them is the failure this catches.
 */
const MUST_STAY_GUARDED: Record<string, string[]> = {
  'post.router.ts': ['create', 'createWithImages', 'addImage'],
  'commentv2.router.ts': ['upsert'],
  'comment.router.ts': ['upsert'],
  'model.router.ts': ['upsert'],
  'article.router.ts': ['upsert'],
  'orchestrator.router.ts': ['iterateGenerate'],
};

/**
 * 🔴 The inversion. `user.resendEmailVerification` is the way OUT of the gate, so it must stay on a
 * procedure the gate does not cover. Promoting it to `guardedProcedure` — the obvious tidy-up, since
 * every neighbour is guarded — makes every gated account permanently unable to verify and therefore
 * permanently unable to post, and nothing else in the suite would notice.
 */
const MUST_NOT_BE_GUARDED: Record<string, string[]> = {
  'user.router.ts': ['resendEmailVerification', 'requestEmailChange'],
};

/**
 * 🔴 Every procedure the routers DERIVE, and the root each is built from.
 *
 * `MUST_STAY_GUARDED` and the alias ban both key on names at CALL SITES, and a downgrade does not
 * have to touch one. `comicProtectedProcedure = protectedProcedure.use(...)` carries **56** bindings;
 * editing that single line moves all 56 at once and no name changes anywhere, so every name-based
 * check stays green. This is the list that cannot grow with the codebase — 15 definitions against
 * 1,142 bindings — which is what makes maintaining it by hand reasonable where a call-site list is not.
 *
 * A red here is not automatically a bug. It means a procedure's effective gate moved, and someone has
 * to say whether that was intended. Update the value in the same commit that moves it, or don't move it.
 */
const DERIVED_BASES: Record<string, string> = {
  auctionProcedure: 'protectedProcedure',
  blurbProcedure: 'protectedProcedure',
  blurbWriteProcedure: 'guardedProcedure',
  buzzMembershipProcedure: 'protectedProcedure',
  buzzProcedure: 'protectedProcedure',
  cashManagementProcedure: 'moderatorProcedure',
  comicGuardedProcedure: 'guardedProcedure',
  comicModeratorProcedure: 'moderatorProcedure',
  comicProtectedProcedure: 'protectedProcedure',
  comicPublicProcedure: 'publicProcedure',
  creatorShopProcedure: 'protectedProcedure',
  experimentalProcedure: 'protectedProcedure',
  giftProcedure: 'protectedProcedure',
  orchestratorGuardedProcedure: 'guardedProcedure',
  orchestratorProcedure: 'protectedProcedure',
};

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Recursive: `src/server/routers/` has subdirectories (`moderator/`), and a non-recursive
 * `readdirSync` made an exemption placed in one of them invisible to a guard whose whole assertion is
 * "used only in the allowlisted routers".
 */
function routerFiles(dir = ROUTERS, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routerFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Path as written in ALLOWLIST — POSIX separators, relative to the routers dir (Windows CI). */
const rel = (full: string) => path.relative(ROUTERS, full).split(path.sep).join('/');

/** `name: <procedure>` — the procedure definitions, not the import line. */
function proceduresUsing(source: string, procedure: string): string[] {
  const body = stripComments(source);
  return [...body.matchAll(new RegExp(`(\\w+)\\s*:\\s*${procedure}\\b`, 'g'))]
    .map((m) => m[1])
    .sort();
}

describe('no unscoped email-verification exemption', () => {
  it('is used only in the allowlisted routers', () => {
    const using = routerFiles()
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes(EXEMPT))
      .map(rel);
    expect(using.sort()).toEqual(Object.keys(ALLOWLIST).sort());
  });

  it.each(Object.entries(ALLOWLIST))('exempts exactly the listed procedures in %s', (file) => {
    const source = readFileSync(path.join(ROUTERS, file), 'utf8');
    expect(proceduresUsing(source, EXEMPT)).toEqual([...ALLOWLIST[file].procedures].sort());
  });

  /**
   * The per-file assertion above matches `name: <symbol>`, so binding the exemption to a local name
   * first (`const p = guardedProcedureAllowUnverifiedEmail`) hides every use of it. Measured: that
   * mutation exempted `user.update` with the suite green.
   */
  it('is never bound to a local alias', () => {
    for (const file of routerFiles()) {
      const body = stripComments(readFileSync(file, 'utf8'));
      expect(body, `${rel(file)} aliases ${EXEMPT}`).not.toMatch(
        new RegExp(`(const|let|var)\\s+\\w+\\s*=\\s*${EXEMPT}\\b`)
      );
    }
  });

  it.each(Object.entries(MUST_STAY_GUARDED))(
    'keeps the content procedures in %s on guardedProcedure',
    (file, procedures) => {
      const source = readFileSync(path.join(ROUTERS, file), 'utf8');
      const guarded = proceduresUsing(source, 'guardedProcedure');
      for (const name of procedures) expect(guarded).toContain(name);
    }
  );

  it.each(Object.entries(MUST_NOT_BE_GUARDED))(
    'keeps the escape hatches in %s off guardedProcedure',
    (file, procedures) => {
      const source = readFileSync(path.join(ROUTERS, file), 'utf8');
      const guarded = proceduresUsing(source, 'guardedProcedure');
      const onProtected = proceduresUsing(source, 'protectedProcedure');
      for (const name of procedures) {
        expect(guarded, `${name} must not be guarded`).not.toContain(name);
        expect(onProtected, `${name} must exist on protectedProcedure`).toContain(name);
      }
    }
  );

  it('pins the base of every procedure the routers derive', () => {
    const found: Record<string, string> = {};
    for (const file of routerFiles()) {
      const body = stripComments(readFileSync(file, 'utf8'));
      for (const m of body.matchAll(/const\s+(\w*[Pp]rocedure)\s*=\s*(\w+)/g)) {
        found[m[1]] = m[2];
      }
    }
    expect(found).toEqual(DERIVED_BASES);
  });

  /**
   * Without this the guard passes trivially the day someone renames the export: every file stops
   * matching, `using` comes back empty, and an empty list still has to equal a non-empty allowlist —
   * so it fails there rather than silently. This asserts the positive case exists at all.
   */
  it('finds the exports it is guarding', () => {
    const trpc = readFileSync(TRPC, 'utf8');
    expect(trpc).toContain(`export const ${EXEMPT} =`);
    expect(trpc).toContain('export const guardedProcedure =');
    expect(routerFiles().length).toBeGreaterThan(50);
  });
});
