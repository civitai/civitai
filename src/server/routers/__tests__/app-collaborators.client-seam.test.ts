import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../test/strip-comments';

/**
 * 🔴 THE PROC↔CLIENT SEAM. Every `appCollaborators.*` procedure must have at least one
 * CALLER in the app, except the four ownership-TRANSFER procs, which are deliberately
 * deferred to a follow-up PR.
 *
 * ## Why this guard exists, stated as the failure it caught
 *
 * The entire collaborator backend shipped across three PRs and reached production with
 * **all twelve procs at zero clients**. Every one of those PRs was individually green:
 * the service suites, the permission matrix, the shadow-hazard tests and the public
 * projection tests all pass on a feature that no user can reach, because every test was
 * scoped to ONE surface and none of them ever asked whether anything CALLS it. That is
 * the isolation-seam failure in its purest form — two hermetically-tested halves, and a
 * defect that lives only in the join.
 *
 * ## What it pins, and in which directions it fails
 *
 * It is a LEDGER of a relationship, not a check on a component, so it fails when the set
 * moves in EITHER direction:
 *
 *   1. SHRINK — a wired proc loses its last caller (a component deleted, a call site
 *      renamed). The proc silently becomes dead server code again.
 *   2. GROWTH — a NEW proc is added to the router with no caller. That is exactly how
 *      this feature shipped unwired the first time, so the default for an unknown proc
 *      is FAIL.
 *   3. THE DEFERRED SET GAINS A CALLER — the follow-up PR wires transfer. That must
 *      fail here too, and the fix is to DELETE the entry from {@link DEFERRED_PROCS}
 *      below. 🔴 That is why the exclusion is an explicit, named list rather than a
 *      `/transfer/i` regex: a regex would silently keep excusing the transfer procs
 *      forever, and would also excuse any future proc that happened to be spelled with
 *      "transfer" in it. A list has to be edited on purpose, entry by entry.
 *
 * ## The population is the DEFINING surface, not a hand-maintained copy
 *
 * The proc names are read out of the router's own object literal via the TypeScript AST.
 * A hand-written list of "the 12 procs" would be a SAMPLE — it would go stale the moment
 * a 13th was added, which is the exact case (2) this guard is for.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTER_FILE = 'src/server/routers/app-collaborators.router.ts';
const ROUTER_EXPORT = 'appCollaboratorsRouter';

/**
 * 🔴 THE DEFERRED SET — the four ownership-TRANSFER procs, out of scope for the
 * collaborator-UI PR and wired by its follow-up.
 *
 * DELETE an entry from this list when its proc gets a client. Do NOT widen it, and do NOT
 * replace it with a pattern.
 */
const DEFERRED_PROCS = [
  'initiateTransfer',
  'acceptTransfer',
  'cancelTransfer',
  'getPendingTransfer',
] as const;

/**
 * Files that may not count as a "client": the router that DECLARES the procs, and the
 * test files that assert against them (including this one). Counting either would make
 * the guard satisfiable by its own text — a harness wired to itself.
 */
function isExcludedFromClientScan(relPath: string): boolean {
  if (relPath === ROUTER_FILE) return true;
  if (relPath.includes('/__tests__/')) return true;
  return /\.(test|browser\.test|spec)\.(ts|tsx)$/.test(relPath);
}

/** Read the router's object-literal keys — the authoritative proc population. */
function readDeclaredProcs(): string[] {
  const abs = path.join(REPO_ROOT, ROUTER_FILE);
  const source = ts.createSourceFile(
    abs,
    fs.readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === ROUTER_EXPORT &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const [arg] = node.initializer.arguments;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            names.push(prop.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * The two shapes a real tRPC client call takes here: `trpc.appCollaborators.<proc>.…`
 * and `utils.appCollaborators.<proc>.invalidate()`.
 *
 * 🔴 THE NAMESPACE IS DISAMBIGUATED, not merely matched. `constants.appCollaborators` is
 * a DIFFERENT object — the config bag holding `maxCollaborators`,
 * `inviteNotifyThrottleHours` and `transferExpiryDays` — and a bare
 * `\bappCollaborators\.(\w+)` matched it too, in the very files that read it.
 *
 * Requiring an explicit `trpc.`/`utils.` receiver is fail-SAFE: a client written in some
 * third shape (a differently-named `useUtils()` binding, say) would not be counted, so
 * its proc would read as UNWIRED and turn this guard RED. Red is the direction someone
 * looks at; a regex loose enough to count prose is not.
 */
const PROC_REFERENCE_RE = /\b(?:trpc|utils)\.appCollaborators\.([A-Za-z_$][\w$]*)/g;

/**
 * `appCollaborators.<proc>` CALL SITES in `text`.
 *
 * 🔴 STRUCTURAL, NOT SPELLED — comments and string literals are removed BEFORE matching.
 * This guard previously reported `getAppEarnings` as WIRED on the strength of a backticked
 * mention inside a JSDoc block, and the prose propping it up was the INVITE DISCLOSURE:
 * the copy promising owners that an editor can read earnings. A user-facing promise with
 * no surface behind it, holding up the guard whose whole job is to notice a missing
 * surface. A guard a COMMENT can satisfy is not a guard.
 */
export function findCollaboratorProcReferences(text: string): string[] {
  return [...stripCommentsAndStrings(text).matchAll(PROC_REFERENCE_RE)].map((m) => m[1]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** proc name → the repo-relative files that reference it. */
function readClientsByProc(): Map<string, string[]> {
  const byProc = new Map<string, string[]>();
  for (const abs of walk(path.join(REPO_ROOT, 'src'))) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (isExcludedFromClientScan(rel)) continue;
    for (const proc of new Set(findCollaboratorProcReferences(fs.readFileSync(abs, 'utf8')))) {
      byProc.set(proc, [...(byProc.get(proc) ?? []), rel]);
    }
  }
  return byProc;
}

describe('appCollaborators proc↔client seam', () => {
  const declared = readDeclaredProcs();
  const clients = readClientsByProc();

  /**
   * 🔴 POSITIVE CONTROL on the scanner, reported BESIDE the zero it is used to assert.
   * "No client found" and "the regex never matches anything" are the same observable, so
   * a bare zero from this scanner proves nothing until it has been watched to count.
   */
  it('the reference scanner CAN find a call (positive control)', () => {
    expect(
      findCollaboratorProcReferences(
        'const q = trpc.appCollaborators.list.useQuery({ appListingId });'
      )
    ).toEqual(['list']);
    expect(
      findCollaboratorProcReferences(
        'void utils.appCollaborators.listMyPendingInvites.invalidate()'
      )
    ).toEqual(['listMyPendingInvites']);
    // …and does NOT match a different router with a similar name.
    expect(findCollaboratorProcReferences('trpc.appListings.list.useQuery()')).toEqual([]);
  });

  /**
   * 🔴 NEGATIVE CONTROLS — the four shapes that used to satisfy this guard with no code
   * behind them. Each is a real defect the scanner shipped with, not a hypothetical:
   * `getAppEarnings` read as WIRED for the whole of this PR on the strength of the first.
   */
  describe('the scanner is STRUCTURAL — prose cannot wire a proc', () => {
    it('a JSDoc mention does NOT count as a client', () => {
      expect(
        findCollaboratorProcReferences(
          '/**\n * An editor can read earnings (`trpc.appCollaborators.getAppEarnings`).\n */'
        )
      ).toEqual([]);
    });

    it('a LINE comment does NOT count as a client', () => {
      expect(
        findCollaboratorProcReferences('// TODO: call trpc.appCollaborators.getAppEarnings here')
      ).toEqual([]);
    });

    it('a STRING LITERAL does NOT count as a client', () => {
      for (const quoted of [
        "const doc = 'trpc.appCollaborators.getAppEarnings';",
        'const doc = "trpc.appCollaborators.getAppEarnings";',
        'const doc = `trpc.appCollaborators.getAppEarnings`;',
      ]) {
        expect(findCollaboratorProcReferences(quoted), quoted).toEqual([]);
      }
    });

    it('🔴 `constants.appCollaborators.*` is a DIFFERENT namespace and does NOT count', () => {
      // The config bag (maxCollaborators / inviteNotifyThrottleHours / transferExpiryDays).
      // A bare `appCollaborators.` match swept these in, in the very files that read them.
      expect(
        findCollaboratorProcReferences('if (seated >= constants.appCollaborators.maxCollaborators)')
      ).toEqual([]);
      expect(
        findCollaboratorProcReferences('constants.appCollaborators.transferExpiryDays * 86_400_000')
      ).toEqual([]);
    });

    it('a real call SURVIVES stripping even when the file is mostly prose', () => {
      // The other direction, and it is what stops the four controls above from passing by
      // deleting everything: over-stripping would make every proc read as unwired.
      const file = [
        '/** Calls `trpc.appCollaborators.getAppEarnings` — prose only. */',
        "// const legacy = 'trpc.appCollaborators.remove';",
        'const q = trpc.appCollaborators.getAppEarnings.useQuery({ appListingId });',
      ].join('\n');
      expect(findCollaboratorProcReferences(file)).toEqual(['getAppEarnings']);
    });
  });

  /**
   * 🔴 POSITIVE CONTROL on the AST reader. A parse that silently returned `[]` would make
   * every assertion below vacuously true.
   */
  it('the router parse CAN read procs (positive control)', () => {
    expect(declared.length).toBeGreaterThanOrEqual(12);
    expect(declared).toContain('invite');
    expect(declared).toContain('getAppEarnings');
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('every DEFERRED proc is a real proc — the list cannot go stale silently', () => {
    for (const proc of DEFERRED_PROCS) {
      expect(declared, `${proc} is in DEFERRED_PROCS but not declared on the router`).toContain(
        proc
      );
    }
  });

  it('every NON-deferred proc has at least one client', () => {
    const unwired = declared
      .filter((proc) => !(DEFERRED_PROCS as readonly string[]).includes(proc))
      .filter((proc) => (clients.get(proc)?.length ?? 0) === 0);
    expect(
      unwired,
      `These appCollaborators procs have ZERO clients. A proc with no caller is dead ` +
        `server code: either wire it, or add it to DEFERRED_PROCS with a reason.`
    ).toEqual([]);
  });

  it('every DEFERRED proc still has ZERO clients — wiring one must edit the list', () => {
    for (const proc of DEFERRED_PROCS) {
      expect(
        clients.get(proc) ?? [],
        `${proc} is listed as deferred but now has a client. Remove it from DEFERRED_PROCS ` +
          `(delete the entry — do not widen the list into a pattern).`
      ).toEqual([]);
    }
  });
});
