import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * POPULATION GUARD for `assertAppBlocksEnabledForTokenUser` — THE App-Blocks kill-switch
 * for a block-token subject (`~/server/services/blocks/block-token-access.service`).
 *
 * ## Why this exists
 *
 * That function was module-private in `blocks.router.ts` until it was shared with the REST
 * route `/api/v1/blocks/me`, so that the two front doors to viewer identity could stop
 * disagreeing about authorization. Exporting it is what fixed the divergence and is also
 * what created this gap: its parameter is a bare `number`, and its contract — that the id
 * MUST be the self-bound token subject, `parseSubjectUserId(claims.sub)` on a verified
 * token, never a value derived from client input — became a convention the moment it
 * stopped being checkable by reading one file.
 *
 * `no-unguarded-block-bridge-token.test.ts` does not cover it: that guard computes
 * reachability textually INSIDE `blocks.router.ts` and is about a different function. So
 * before this file, nothing enumerated who may call the kill-switch.
 *
 * ## 🔴 WHAT THIS PINS, AND WHAT IT DOES NOT — read this before trusting it
 *
 * PINS: the SET of production modules that import and call the shared gate. It fails when
 * that set GROWS (a third consumer appears) or SHRINKS (one stops calling it), and when
 * the per-consumer call COUNT changes (a new call site inside an existing consumer).
 *
 * DOES NOT PIN: that each call site self-binds. Proving "this argument descends from
 * `parseSubjectUserId(claims.sub)`" textually is not something a regex can do honestly,
 * and a structural check type-checks past a wrong argument anyway. That is deliberate and
 * it is the limit of this guard — writing a check whose description is wider than its
 * implementation is the exact defect the change this file ships alongside exists to fix.
 *
 * What it buys is the thing that actually decays: a NEW caller cannot land silently. It
 * lands here, in a diff, next to the contract — and whoever updates this table has to read
 * that contract to do it. Self-binding stays a human check, made unavoidable rather than
 * automatic.
 *
 * ## 🔴 THE NAME IS AMBIGUOUS AND MATCHING ON IT IS WRONG
 *
 * `services/apps/app-storage.service.ts` declares its OWN module-private
 * `assertAppBlocksEnabledForTokenUser`,
 * taking `(userId, op)` and incrementing `appStorageOpsCounter` on both refusals. It is a
 * deliberate, documented divergence — NOT a consumer of the shared gate. A ledger that
 * grepped the bare name would count it, then "reconcile" two functions that are separate on
 * purpose. So consumption is resolved by IMPORT of the service module, never by name, and
 * that module is asserted as an explicit NEGATIVE control below: if it ever starts
 * matching, the discriminator has broken and every number here is suspect.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const GATE = 'assertAppBlocksEnabledForTokenUser';
const SERVICE_SPECIFIER = '~/server/services/blocks/block-token-access.service';

/** The module that DEFINES the gate. Not a consumer of it. */
const DEFINING_MODULE = 'src/server/services/blocks/block-token-access.service.ts';

/**
 * Declares its own same-named private function. Asserted NOT to resolve as a consumer —
 * the positive control that import-resolution really is discriminating, rather than this
 * file silently matching nothing at all.
 */
// (It lived in `src/server/routers/apps.router.ts` until the per-viewer storage
// implementation moved out so the `/api/v1/blocks/app-storage/*` routes could import it
// without module-evaluating `appsRouter`. Same private function, new file.)
const NAME_COLLISION_MODULE = 'src/server/services/apps/app-storage.service.ts';

/**
 * Every PRODUCTION consumer of the SHARED gate, with its call count and why it is allowed
 * to call it. Update in the same commit as any change to the set.
 *
 * 🔴 Each entry's `selfBinds` is the reviewer's note, not a machine-checked fact — see the
 * limits above. It records WHERE the subject comes from so the next person does not have
 * to re-derive it.
 */
const LEDGER: Record<string, { calls: number; selfBinds: string; why: string }> = {
  'src/server/routers/blocks.router.ts': {
    // 17 → 16: `updateUserSettings` no longer calls the gate inline. Its whole body was
    // extracted to `user-settings.service.ts` (below) so the new REST twin
    // `POST /api/v1/blocks/user-checkpoint/set` reaches the SAME gates; the call moved
    // WITH the body rather than being dropped. Net production call sites are unchanged.
    calls: 16,
    selfBinds: 'parseSubjectUserId(claims.sub) on claims from authorizeBlockBridgeToken',
    why: 'The tRPC bridge procs. Block-JWT-authed publicProcedures, so the flag cannot be evaluated against ctx.user and must be evaluated against the token subject.',
  },
  'src/server/services/blocks/user-settings.service.ts': {
    calls: 1,
    selfBinds:
      'parseSubjectUserId(claims.sub) on claims from authorizeBlockBridgeToken — taken by the CALLER (the router proc, or this module’s own token-taking wrapper) and passed in as verified claims, never as a client-supplied id',
    why: 'The per-viewer block-settings write, shared by BOTH transports: the tRPC bridge proc blocks.updateUserSettings and the REST route /api/v1/blocks/user-checkpoint/set. Sharing this exact function is what makes the two doors agree about the kill switch — the same reason me.ts is in this set. The subject it binds to is also the subject the write is KEYED on (block_user_settings.user_id), so a gate evaluated against anything else would be checking a different person than the row belongs to.',
  },
  'src/pages/api/v1/blocks/me.ts': {
    calls: 1,
    selfBinds: 'parseSubjectUserId(claims.sub) on claims stamped by withBlockScope',
    why: 'The REST twin of blocks.getMyViewer. Joined this set when its hardcoded isModerator literal was dropped in favour of the Flipt gate; sharing this exact function is what makes the two doors agree.',
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative, POSIX-separated, so the ledger keys are platform-independent. */
function rel(file: string): string {
  return relative(ROOT, file).split(sep).join('/');
}

/** True iff the file IMPORTS the gate from the service module (never a bare name match). */
function importsSharedGate(source: string): boolean {
  const importRe = new RegExp(
    String.raw`import\s*\{[^}]*\b${GATE}\b[^}]*\}\s*from\s*['"]${SERVICE_SPECIFIER.replace(
      /[/~.]/g,
      '\\$&'
    )}['"]`,
    's'
  );
  return importRe.test(source);
}

/** Call sites: the gate's name followed by an open paren, excluding the import line. */
function countCalls(source: string): number {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\b/.test(line))
    .reduce((n, line) => n + (line.includes(`${GATE}(`) ? 1 : 0), 0);
}

describe('assertAppBlocksEnabledForTokenUser — production call-site ledger', () => {
  const files = walk(SRC).filter((f) => rel(f) !== DEFINING_MODULE);
  const consumers = files.filter((f) => importsSharedGate(readFileSync(f, 'utf8'))).map(rel);

  it('the consumer set is EXACTLY the ledger — a new caller fails here', () => {
    expect(
      consumers.sort(),
      'A production module now imports the App-Blocks kill-switch. Its argument MUST be the ' +
        'self-bound token subject (parseSubjectUserId(claims.sub) on a verified token), never ' +
        'a value from client input — read the contract on the function before adding it here.'
    ).toEqual(Object.keys(LEDGER).sort());
  });

  it('each consumer calls it the recorded number of times', () => {
    const actual: Record<string, number> = {};
    for (const c of consumers) actual[c] = countCalls(readFileSync(join(ROOT, c), 'utf8'));
    const expected = Object.fromEntries(Object.entries(LEDGER).map(([k, v]) => [k, v.calls]));
    expect(actual).toEqual(expected);
  });

  it('NEGATIVE CONTROL: the same-named private function in app-storage.service.ts is NOT counted', () => {
    // It declares its own `(userId, op)` variant and imports nothing from the service. If
    // this ever flips, the import discriminator has broken and both assertions above are
    // measuring the wrong population rather than passing honestly.
    const source = readFileSync(join(ROOT, NAME_COLLISION_MODULE), 'utf8');
    expect(source).toContain(`async function ${GATE}(`);
    expect(importsSharedGate(source)).toBe(false);
    expect(consumers).not.toContain(NAME_COLLISION_MODULE);
  });

  it('POSITIVE CONTROL: the detector finds a real consumer, so a green set is not a wired-to-nothing zero', () => {
    // A reassuring "the set matches" is indistinguishable from a walker that scanned no
    // files or a regex that can never match. Assert the population is non-empty, that the
    // walk reached a meaningful number of files, and that the detector fires on a known
    // consumer's actual source.
    expect(files.length).toBeGreaterThan(500);
    // 2 → 3 with `user-settings.service.ts`, the extracted viewer-settings write body.
    expect(consumers.length).toBe(3);
    expect(
      importsSharedGate(readFileSync(join(ROOT, 'src/pages/api/v1/blocks/me.ts'), 'utf8'))
    ).toBe(true);
  });
});
