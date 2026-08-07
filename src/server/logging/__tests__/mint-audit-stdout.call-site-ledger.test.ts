import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * RELATIONSHIP GUARD for the mint-audit DUAL SINK (#3715, step 3 of #3703).
 *
 * The behavioural suites prove each of the five mint-audit events is individually
 * mirrored to stdout. What none of them can express is the property that actually
 * decays: that the SET of mint-audit emit sites is closed, and that every member of it
 * writes to BOTH sinks.
 *
 * Why both sinks are required, and why a missing one is invisible: `req.log?.info`
 * goes to next-axiom, whose `Logger.sendLogs()` prints to the console ONLY when the
 * AXIOM_* env vars are UNSET (`@civitai/next-axiom/dist/logger.js:198-202`). With them
 * set — production — the batch is POSTed to Axiom's HTTP ingest and NOTHING is written
 * to stdout, so a log store that scrapes container stdout cannot see the event at all.
 * The step-3 adoption gate flips a spend default once `spendGrantBasis === 'inferred'`
 * falls to zero; read from a surface that structurally cannot see the event, that zero
 * is guaranteed and meaningless. So a NEW mint-audit event added with only the Axiom
 * sink would be silently unreadable, and dropping a mirror would silently re-open the
 * blind spot — in both cases with every existing test still green.
 *
 * This ledger fails when the set GROWS (a mint path added without a mirror, or a mirror
 * added without the ledger being updated) or SHRINKS (one removed or renamed, and the
 * reasoning recorded here went stale). A structural check type-checks past a wrong
 * argument, so it is deliberately NOT the only guard — the behavioural assertions in
 * `src/tests/api/v1/blocks/dev-token.test.ts` and
 * `src/tests/api/v1/block-tokens/dev-tunnel-{mint,owned-nonapproved-mint}.test.ts` pin
 * the payloads (including the three-valued `requestBudgetedSpend` signal). This pins
 * the population.
 *
 * Test files are OUT of scope on purpose: a test may legitimately reference any event
 * name. The ledger is about PRODUCTION emit sites.
 */

const ROOT = process.cwd();

/**
 * Every PRODUCTION mint-audit event, mapped to the file that emits it and why it is
 * audited. Update this table in the same commit as any change to the set.
 */
const MINT_AUDIT_LEDGER: Record<string, { file: string; why: string }> = {
  'blocks.dev-token.pending-mint': {
    file: 'src/pages/api/v1/blocks/dev-token.ts',
    why: 'BEARER dev-token mint against a PENDING publish request. The synthetic `pending-<id>` appId writes no durable audit rows, so the event is the only forensic trail. Carries the three-valued requestBudgetedSpend + the derived spendGrantBasis the step-3 gate counts.',
  },
  'blocks.dev-token.local-mint': {
    file: 'src/pages/api/v1/blocks/dev-token.ts',
    why: 'BEARER dev-token mint against a brand-new local manifest (NO row). Synthetic `local-<slug>` ids resolve to nothing, so no durable rows exist. Same three-valued spend audit as its siblings.',
  },
  'blocks.dev-token.approved-mint': {
    file: 'src/pages/api/v1/blocks/dev-token.ts',
    why: 'BEARER dev-token mint against an APPROVED app. It DOES write durable rows, but they are byte-identical to a production page mint, so only this event distinguishes a dev mint and records the spend-grant basis.',
  },
  'app-blocks.dev-tunnel.mint': {
    file: 'src/pages/api/v1/block-tokens/index.ts',
    why: 'DEV TUNNEL ephemeral (pre-approval) mint. A synthetic `ephemeral-<slug>` app has no AppBlock-backed row; this is the record of granting a possibly spend-capable token to an un-approved app.',
  },
  'app-blocks.dev-tunnel.owned-nonapproved-mint': {
    file: 'src/pages/api/v1/block-tokens/index.ts',
    why: 'DEV TUNNEL owned NON-APPROVED mint. Parity with the ephemeral branch: the record of granting a possibly spend-capable token to an app no moderator approved.',
  },
};

/** `emitMintAuditToStdout('<event>'` — the stdout mirror. */
const MIRROR_RE = /emitMintAuditToStdout\(\s*'([^']+)'/g;
/** `…log?.info('<event>'` / `…log.info('<event>'` — the Axiom sink. */
const AXIOM_RE = /\blog\??\.info\(\s*'([^']+)'/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test .ts/.tsx under src/, as repo-relative POSIX-ish paths. */
function sourceFiles(): string[] {
  return walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((f) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(f));
}

const FILES = sourceFiles();

/**
 * Source with comments removed. There is a LOT of prose about these events (including
 * the event names themselves, quoted); only real code may count as an emit site.
 */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CODE = new Map(FILES.map((f) => [f, code(f)] as const));

/** Every `[event, file]` pair matched by `re` across the production population. */
function emits(re: RegExp): [string, string][] {
  const out: [string, string][] = [];
  for (const [file, src] of CODE) {
    for (const m of src.matchAll(new RegExp(re.source, 'g'))) out.push([m[1], file]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

const MIRRORS = emits(MIRROR_RE);
/** Axiom-sink events whose name looks like a mint audit (`…-mint` / `….mint`). */
const AXIOM_MINTS = emits(AXIOM_RE).filter(([name]) => /(^|[.-])mint$/.test(name));

const LEDGER_NAMES = Object.keys(MINT_AUDIT_LEDGER).sort();

describe('mint-audit stdout-mirror call-site ledger (#3715)', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk / a regex that matches nothing would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/pages/api/v1/blocks/dev-token.ts');
    expect(FILES).toContain('src/pages/api/v1/block-tokens/index.ts');
    expect(MIRRORS.length).toBeGreaterThan(0);
    expect(AXIOM_MINTS.length).toBeGreaterThan(0);
    // …and that it can go RED: a definitely-absent emitter must match nothing.
    expect(emits(/emitMintAuditToStdoutNoSuchFunction\(\s*'([^']+)'/)).toEqual([]);
  });

  it('the set of STDOUT-MIRRORED mint-audit events EXACTLY equals the ledger (fails on GROWTH and on SHRINK)', () => {
    // Enumerated equality, not containment: a 6th mirrored event fails here, and so
    // does deleting one of the five. The message names the ledger so the fix is obvious.
    expect(
      MIRRORS.map(([name]) => name).sort(),
      'update MINT_AUDIT_LEDGER in this file in the same commit as the emit-site change'
    ).toEqual(LEDGER_NAMES);
  });

  it('every mirrored event is emitted from the file the ledger names', () => {
    const byName = new Map(MIRRORS);
    for (const [name, { file }] of Object.entries(MINT_AUDIT_LEDGER)) {
      expect(byName.get(name), `${name} must be mirrored from ${file}`).toBe(file);
    }
  });

  it('THE DUAL SINK: every mint-audit event reaches BOTH sinks, from the SAME file', () => {
    // The property that actually matters, and the one no per-path test can express.
    //
    // Asserted as SET DIFFERENCES, not as two set equalities. A set equality fires
    // whichever side changed but its message names only one direction, so deleting a
    // mirror reported "…with NO Axiom sink", the exact opposite of the real defect —
    // a maintainer would be sent the wrong way. A difference asserts precisely the
    // direction its message describes.
    const axiomByName = new Map(AXIOM_MINTS);
    const mirrorByName = new Map(MIRRORS);
    const axiomNames = [...axiomByName.keys()].sort();
    const mirrorNames = [...mirrorByName.keys()].sort();

    expect(
      axiomNames.filter((n) => !mirrorByName.has(n)),
      'these mint-audit events reach Axiom but have NO stdout mirror — they are invisible to the stdout-scraped log store, so the #3703 step-3 gate would read a structurally guaranteed zero. Add emitMintAuditToStdout beside the req.log call.'
    ).toEqual([]);
    expect(
      mirrorNames.filter((n) => !axiomByName.has(n)),
      'these mint-audit events are mirrored to stdout but have NO Axiom sink — the rich sink was dropped. Restore the req.log call.'
    ).toEqual([]);
    // Both sinks present, so the union is the population the ledger must describe.
    expect(
      axiomNames,
      'the mint-audit event population changed — update MINT_AUDIT_LEDGER in this file'
    ).toEqual(LEDGER_NAMES);
    for (const name of LEDGER_NAMES) {
      expect(mirrorByName.get(name), `${name}: both sinks must live in the same file`).toBe(
        axiomByName.get(name)
      );
    }
  });

  it('every ledger entry carries a non-trivial rationale', () => {
    for (const [name, { why }] of Object.entries(MINT_AUDIT_LEDGER)) {
      expect(why.length, `${name} rationale`).toBeGreaterThan(80);
    }
  });

  it('the helper is defined in exactly ONE place (no open-coded second emitter)', () => {
    // The whole point of the shared emitter: five call sites, one definition. An
    // open-coded `console.log(JSON.stringify({ event: '<a mint event>' …` at a mint site
    // would drift from the helper's no-normalisation contract, which the three-valued
    // requestBudgetedSpend signal depends on.
    const definers = FILES.filter((f) =>
      /export function emitMintAuditToStdout\b/.test(CODE.get(f)!)
    );
    expect(definers).toEqual(['src/server/logging/mint-audit-stdout.ts']);
    for (const name of LEDGER_NAMES) {
      const openCoded = FILES.filter((f) =>
        new RegExp(`console\\.log\\([^\\n]*${name.replace(/[.]/g, '\\.')}`).test(CODE.get(f)!)
      );
      expect(openCoded, `${name} must go through the shared emitter`).toEqual([]);
    }
  });
});
