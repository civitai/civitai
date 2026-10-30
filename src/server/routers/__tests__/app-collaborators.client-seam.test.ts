import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../test/strip-comments';

/**
 * 🔴 THE PROC↔CLIENT SEAM. Every `appCollaborators.*` procedure must have at least one
 * CALLER in the app. {@link DEFERRED_PROCS} is now EMPTY — the four ownership-transfer
 * procs it used to hold were wired by the follow-up PR, and their entries were deleted.
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
 * 🔴 THE DEFERRED SET — procs knowingly shipped without a client. **EMPTY.**
 *
 * It held the four ownership-TRANSFER procs while the collaborator-UI PR shipped without
 * them. The follow-up PR wired them and DELETED the four entries, which is the event
 * {@link TRANSFER_PROCS} below asserts on.
 *
 * DELETE an entry from this list when its proc gets a client. Do NOT widen it, and do NOT
 * replace it with a pattern.
 */
const DEFERRED_PROCS = [] as const;

/**
 * 🔴 THE DELETION LEDGER — the entries that had to leave {@link DEFERRED_PROCS}.
 *
 * This is the assertion the file's own predecessor recommended, and it exists because the
 * "every DEFERRED proc still has ZERO clients" test below is now VACUOUS: it iterates an
 * empty list, so it passes whatever anyone does to the transfer procs. Naming them here
 * moves the guard from "no deferred proc is wired" (unfalsifiable once the list empties)
 * to "THESE FIVE procs are not deferred AND each has a client" — which fails in both
 * directions: re-adding an entry, and deleting the last caller of one.
 *
 * 🔴 IT DOES NOT DEPEND ON `PROC_REFERENCE_RE`'s FAIL-OPEN DIRECTION. The membership half
 * is a plain list comparison the scanner cannot influence at all, so even a scanner that
 * missed every call still fails this test the moment a proc is re-deferred.
 */
const TRANSFER_PROCS = [
  'initiateTransfer',
  'acceptTransfer',
  'cancelTransfer',
  'getPendingTransfer',
  'listMyPendingTransfers',
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
 * Requiring an explicit `trpc.`/`utils.` receiver is fail-SAFE **for the "every proc has a
 * client" direction**: a client written in some third shape (a differently-named
 * `useUtils()` binding, say) would not be counted, so its proc would read as UNWIRED and
 * turn this guard RED. Red is the direction someone looks at; a regex loose enough to
 * count prose is not.
 *
 * 🔴 IT USED TO BE FAIL-OPEN FOR THE OPPOSITE DIRECTION — the `DEFERRED_PROCS` "must have
 * ZERO clients" assertion. A proc reached through a shape a single receiver-anchored regex
 * does not recognise (`const { initiateTransfer } = trpc.appCollaborators;`, or an aliased
 * `const u = trpc.useUtils(); u.appCollaborators.…`) was NOT counted, so that check kept
 * passing while the proc was in fact wired.
 *
 * BOTH remedies its predecessor named were taken, because they cover different failures:
 *   - the scanner now recognises the two extra receiver shapes (below), so a wired proc
 *     is COUNTED however it was reached; and
 *   - the deferred set is asserted by DELETION (`TRANSFER_PROCS`), which does not depend
 *     on the scanner at all — a list comparison cannot be fooled by a receiver shape
 *     nobody anticipated, and receiver shapes are open-ended.
 *
 * The old bare `\bappCollaborators\.(\w+)` is still NOT the answer: it counted comments,
 * strings and `constants.appCollaborators.*` (the config bag), which is how
 * `getAppEarnings` shipped "wired". Each shape below is anchored on a receiver that can
 * only be the tRPC client.
 */
const PROC_REFERENCE_RE = /\b(?:trpc|utils)\.appCollaborators\.([A-Za-z_$][\w$]*)/g;

/**
 * SHAPE 2 — a DESTRUCTURED receiver: `const { initiateTransfer, list } = trpc.appCollaborators;`
 * The names come from the brace group; `foo: bar` and `foo = fallback` are reduced to the
 * KEY, which is the proc name (the local binding is irrelevant to the seam).
 */
const DESTRUCTURED_RECEIVER_RE = /\{([^{}]*)\}\s*=\s*(?:trpc|utils)\.appCollaborators\b/g;

/**
 * SHAPE 3 — an ALIASED utils binding: `const u = trpc.useUtils(); u.appCollaborators.…`.
 *
 * 🔴 The alias is DISCOVERED from the file, never guessed: only an identifier this file
 * actually assigns from `trpc.useUtils()` / `trpc.useContext()` is treated as a receiver.
 * Accepting an arbitrary `<ident>.appCollaborators.<name>` would re-admit
 * `constants.appCollaborators.transferExpiryDays`, which is the exact false positive the
 * receiver anchor exists to exclude.
 */
const UTILS_ALIAS_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*trpc\.(?:useUtils|useContext)\(\)/g;

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
  const code = stripCommentsAndStrings(text);
  const found: string[] = [];

  for (const m of code.matchAll(PROC_REFERENCE_RE)) found.push(m[1]);

  for (const m of code.matchAll(DESTRUCTURED_RECEIVER_RE)) {
    for (const part of m[1].split(',')) {
      // `foo`, `foo: local`, `foo = fallback`, `foo: local = fallback` → `foo`.
      const key = part.split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) found.push(key);
    }
  }

  for (const alias of new Set([...code.matchAll(UTILS_ALIAS_RE)].map((m) => m[1]))) {
    const aliasRe = new RegExp(`\\b${alias}\\.appCollaborators\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of code.matchAll(aliasRe)) found.push(m[1]);
  }

  return found;
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
   * 🔴 THE BYPASS THIS SCANNER USED TO WAVE THROUGH, now a control.
   *
   * Each of these is a REAL way to call a proc that the receiver-anchored regex alone did
   * not see, which made the `DEFERRED_PROCS` "zero clients" assertion fail-OPEN: a
   * transfer proc could be fully wired behind one of them and the guard would stay green.
   * Written as an expectation of the SPECIFIC proc name so a scanner that returned
   * everything (or nothing) fails.
   */
  describe('🔴 the scanner sees the receiver shapes that used to bypass it', () => {
    it('a DESTRUCTURED receiver counts as a client', () => {
      expect(
        findCollaboratorProcReferences('const { initiateTransfer } = trpc.appCollaborators;')
      ).toEqual(['initiateTransfer']);
    });

    it('…including several at once, renamed, and off `utils`', () => {
      expect(
        findCollaboratorProcReferences(
          'const { acceptTransfer, cancelTransfer: cancel } = utils.appCollaborators;'
        )
      ).toEqual(['acceptTransfer', 'cancelTransfer']);
    });

    it('an ALIASED useUtils() binding counts as a client', () => {
      expect(
        findCollaboratorProcReferences(
          'const u = trpc.useUtils();\nvoid u.appCollaborators.getPendingTransfer.invalidate();'
        )
      ).toEqual(['getPendingTransfer']);
    });

    /**
     * 🔴 NEGATIVE CONTROL ON THE WIDENING, and it is the reason the alias is discovered
     * rather than assumed. `constants.appCollaborators.transferExpiryDays` is a
     * `<ident>.appCollaborators.<name>` too — accepting any identifier as a receiver would
     * have re-created the exact false positive that shipped `getAppEarnings` as "wired".
     */
    it('an identifier that is NOT bound to trpc.useUtils() is still not a receiver', () => {
      expect(
        findCollaboratorProcReferences(
          'const days = constants.appCollaborators.transferExpiryDays;'
        )
      ).toEqual([]);
      // …and a destructure off something that is not the tRPC client is not one either.
      expect(
        findCollaboratorProcReferences('const { maxCollaborators } = constants.appCollaborators;')
      ).toEqual([]);
    });
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

  /**
   * 🔴 THE DELETION ASSERTION. The test above is VACUOUS now that `DEFERRED_PROCS` is
   * empty — it iterates nothing — so it can no longer notice anything about transfer. This
   * one names the procs directly and fails in both directions: re-adding an entry to the
   * deferred list, and dropping the last caller of any of them.
   */
  describe('🔴 ownership transfer is WIRED — the deferred entries were deleted', () => {
    it('none of the transfer procs is deferred any more', () => {
      for (const proc of TRANSFER_PROCS) {
        expect(
          DEFERRED_PROCS as readonly string[],
          `${proc} is back in DEFERRED_PROCS. Ownership transfer has a UI — a proc it uses ` +
            `may not be excused from the client-seam check.`
        ).not.toContain(proc);
      }
      // POSITIVE CONTROL on this assertion's own instrument: the list really is empty, so
      // "not contained" is a fact about the list rather than about a typo in a name.
      expect(DEFERRED_PROCS).toEqual([]);
    });

    it('every transfer proc is DECLARED on the router', () => {
      for (const proc of TRANSFER_PROCS) expect(declared).toContain(proc);
    });

    it('every transfer proc has at least one CLIENT', () => {
      const unwired = TRANSFER_PROCS.filter((proc) => (clients.get(proc)?.length ?? 0) === 0);
      expect(
        unwired,
        `These ownership-transfer procs have ZERO clients. The transfer UI is the thing ` +
          `that makes them reachable; if it was removed, re-defer them explicitly.`
      ).toEqual([]);
    });
  });
});
