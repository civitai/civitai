import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A workflow submitted with a USER's orchestrator token must have its owner checked.
 *
 * The orchestrator derives the whole identity of a submit from the bearer: who owns the
 * workflow, whose queue it joins, whose Buzz pays. When that resolution goes wrong the
 * failure is silent and it moves money — roughly a thousand generations over six hours on
 * 2026-08-30 were owned, queued and billed to accounts that did not make them, and nothing
 * in the app noticed. `assertWorkflowOwner` is the check; this is what stops its coverage
 * decaying as new submit paths are added.
 *
 * WHY A GUARD AND NOT A TYPE. The check has to run AFTER the submit returns, on a value the
 * orchestrator produced, so nothing in the type system can require it. The realistic way it
 * regresses is not someone deleting it — it is a new paid feature growing its own
 * `submitWorkflow` call, which no reviewer of THAT diff has any reason to connect to an
 * incident in a different subsystem.
 *
 * A RATCHET, NOT A SNAPSHOT — it fails in both directions. A new unguarded user-token submit
 * fails it; so does wiring one up without dropping its exemption. The second direction is the
 * one allowlists rot without, and it is what keeps this list draining rather than growing.
 *
 * SCOPE. Only calls through the `~/server/services/orchestrator/workflows` wrapper that pass
 * `token`. A call passing `client:` is the generated `@civitai/client` used with
 * `internalOrchestratorClient` — the system account, which legitimately owns what it submits.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO_ROOT, 'src');

/**
 * Exempt call sites, keyed by repo-relative file, with the number of unguarded user-token
 * submits in that file and why. `reason` is not decoration: it is what tells the next reader
 * whether the exemption is still true.
 */
const EXEMPT: Record<string, { unguarded: number; reason: string }> = {
  'src/server/routers/blocks.router.ts': {
    unguarded: 7,
    reason:
      'App Blocks: 4 paid submits + 3 whatIf/quote estimates. The paid ones SHOULD be guarded, ' +
      'but blocks record spend through reserveBlockBuzzSpend rather than a generation/training ' +
      'buzzTransaction, so their workflow-id shape is not confirmed against the ledger the way ' +
      'the other paths are (1.16M rows, prefix == payer). Guarding on an unconfirmed id shape ' +
      'would fail open and inflate orchestrator_consumer_unverifiable_total instead of ' +
      'protecting anything. Confirm the id shape on a real block submit first.',
  },
  'src/server/services/comics/orchestrator-chat.ts': {
    unguarded: 2,
    reason:
      'Comics chat-completion submits, which do carry `currencies` and so do spend. Same ' +
      'blocker as blocks: a chatCompletion workflow id has not been checked against the ledger.',
  },
  'src/server/services/orchestrator/orchestration-new.service.ts': {
    unguarded: 1,
    reason:
      'whatIfFromGraph — a cost estimate. `query: { whatif: true }` produces no persisted ' +
      'workflow and no debit, so there is no attribution to check.',
  },
  'src/server/services/orchestrator/promptEnhancement.ts': {
    unguarded: 1,
    reason:
      'Prompt enhancement. Submits under the user token but records no buzzTransaction, so a ' +
      'mis-attribution costs the user nothing; the id shape is likewise unconfirmed.',
  },
  'src/server/services/orchestrator/training/training.orch.ts': {
    unguarded: 1,
    reason:
      'The whatIf estimate at `query: { whatif: true }`. The real training submit IS guarded.',
  },
  'src/server/services/orchestrator/workflows.ts': {
    unguarded: 1,
    reason:
      'The wrapper itself (submitWorkflowWithRetry). Guarding here would run the check on every ' +
      'submit including the system-token ones, which the system account legitimately owns.',
  },
};

type Site = { file: string; line: number };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full, out);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * 🔴 Called from INSIDE the tests, never at module scope. Thrown from a `describe` body this
 * would be a COLLECTION failure: the file contributes zero tests, the suite's failure count
 * does not move, and the guard is silently absent from every full-suite run.
 */
function scan(): { userTokenSites: Site[]; guardedFiles: Set<string> } {
  const userTokenSites: Site[] = [];
  const guardedFiles = new Set<string>();

  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('submitWorkflow({')) continue;
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const lines = source.split('\n');

    lines.forEach((line, i) => {
      if (!/\bsubmitWorkflow\(\{\s*$/.test(line)) return;
      // The argument object's opening lines are enough to tell the two callees apart: the
      // wrapper takes `token`, the generated client takes `client`.
      const head = lines.slice(i, i + 12).join('\n');
      if (/^\s*client:/m.test(head)) return; // system account — legitimately owns its submits
      if (!/^\s*token[,:]/m.test(head)) return;
      userTokenSites.push({ file: rel, line: i + 1 });
    });

    if (/\bassertWorkflowOwner\(/.test(source)) guardedFiles.add(rel);
  }

  return { userTokenSites, guardedFiles };
}

describe('no unguarded user-token workflow submit', () => {
  it('finds the submit sites at all — a scan that matches nothing would pass vacuously', () => {
    const { userTokenSites } = scan();
    // Two of these are the guarded generation + training submits, so the floor is well above
    // zero even if every exemption below is eventually retired.
    expect(userTokenSites.length).toBeGreaterThanOrEqual(10);
  });

  it('guards every user-token submit, or names it as an exemption with a reason', () => {
    const { userTokenSites } = scan();

    const perFile = new Map<string, number>();
    for (const site of userTokenSites) perFile.set(site.file, (perFile.get(site.file) ?? 0) + 1);

    const unexplained: string[] = [];
    for (const [file, submits] of perFile) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const guards = (source.match(/\bassertWorkflowOwner\(/g) ?? []).length;
      const exemptCount = EXEMPT[file]?.unguarded ?? 0;
      if (submits - guards !== exemptCount) {
        unexplained.push(
          `${file}: ${submits} user-token submit(s), ${guards} guarded, ` +
            `${exemptCount} allowlisted — ${submits - guards} unaccounted for`
        );
      }
    }

    expect(
      unexplained,
      'A submit made with a user’s orchestrator token must be followed by ' +
        'assertWorkflowOwner(workflow, userId, token), or be added to EXEMPT in this file with ' +
        'a reason. Unguarded, a mis-resolved consumer bills a stranger silently. If you WIRED ' +
        'one up, drop its exemption here in the same commit — this ratchet fails in both ' +
        'directions on purpose.'
    ).toEqual([]);
  });

  it('keeps no exemption for a file that no longer has one', () => {
    const { userTokenSites } = scan();
    const files = new Set(userTokenSites.map((s) => s.file));

    const stale = Object.keys(EXEMPT).filter((file) => !files.has(file));

    expect(
      stale,
      'These files no longer contain a user-token submit; drop their EXEMPT entry.'
    ).toEqual([]);
  });

  it('requires a reason on every exemption', () => {
    const missing = Object.entries(EXEMPT)
      .filter(([, entry]) => !entry.reason?.trim())
      .map(([file]) => file);

    expect(missing).toEqual([]);
  });
});
