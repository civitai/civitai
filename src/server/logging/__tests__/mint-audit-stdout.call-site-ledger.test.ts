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
 * So a NEW mint-audit event added with only the Axiom sink has no short-window forensic
 * copy, and dropping a mirror silently removes one — in both cases with every existing
 * test still green. That is what this ledger detects.
 *
 * 🔴 BUT THE TWO SINKS ANSWER DIFFERENT QUESTIONS, AND THIS LEDGER DOES NOT MAKE STDOUT
 * A SUBSTITUTE FOR AXIOM. The stdout mirror is a SHORT-WINDOW (~72h measured) forensic
 * copy, useful at incident time. The 30-day #3715 adoption gate
 * (`spendGrantBasis === 'inferred'` over a rolling 30 days) is read from AXIOM, whose
 * retention is ~96 days, via the APL queries recorded on that issue. At ~0.8 bearer
 * mints/day a 72h window holds ~2.4 mints total, so a "30-day" query against stdout
 * returns a near-unconditional 0 — the same structurally guaranteed zero this work
 * exists to eliminate, just at a 3-day horizon. Full reasoning and the measured numbers
 * are in `src/server/logging/mint-audit-stdout.ts`.
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
type LedgerEntry = {
  file: string;
  /**
   * 'gate-bearing' — carries `requestBudgetedSpend` + `spendGrantBasis`, so it counts
   * toward the #3715 30-day adoption gate (read from Axiom, not from stdout).
   * 'audit-only'  — carries `spendGranted` only; forensic record, NOT gate input.
   *
   * 🔴 A reader who counts all five against the gate gets the WRONG DENOMINATOR, and the
   * audit-only path is the BUSIER one in practice, which makes that mistake easy to
   * reach for. Only 3 of the 5 are gate input.
   */
  kind: 'gate-bearing' | 'audit-only';
  why: string;
};

const MINT_AUDIT_LEDGER: Record<string, LedgerEntry> = {
  'blocks.dev-token.pending-mint': {
    file: 'src/pages/api/v1/blocks/dev-token.ts',
    kind: 'gate-bearing',
    why: 'BEARER dev-token mint against a PENDING publish request. The synthetic `pending-<id>` appId writes no durable audit rows, so the event is the only forensic trail. Carries the three-valued requestBudgetedSpend + the derived spendGrantBasis the step-3 gate counts.',
  },
  'blocks.dev-token.local-mint': {
    file: 'src/pages/api/v1/blocks/dev-token.ts',
    kind: 'gate-bearing',
    why: 'BEARER dev-token mint against a brand-new local manifest (NO row). Synthetic `local-<slug>` ids resolve to nothing, so no durable rows exist. Same three-valued spend audit as its siblings.',
  },
  'blocks.dev-token.approved-mint': {
    file: 'src/pages/api/v1/blocks/dev-token.ts',
    kind: 'gate-bearing',
    why: 'BEARER dev-token mint against an APPROVED app. It DOES write durable rows, but they are byte-identical to a production page mint, so only this event distinguishes a dev mint and records the spend-grant basis.',
  },
  'app-blocks.dev-tunnel.mint': {
    file: 'src/pages/api/v1/block-tokens/index.ts',
    kind: 'audit-only',
    why: 'DEV TUNNEL ephemeral (pre-approval) mint. A synthetic `ephemeral-<slug>` app has no AppBlock-backed row; this is the record of granting a possibly spend-capable token to an un-approved app. NO spendGrantBasis: the tunnel path has no per-mint request mechanism, so there is no basis to derive — correct per #3715, not an omission.',
  },
  'app-blocks.dev-tunnel.owned-nonapproved-mint': {
    file: 'src/pages/api/v1/block-tokens/index.ts',
    kind: 'audit-only',
    why: 'DEV TUNNEL owned NON-APPROVED mint. Parity with the ephemeral branch: the record of granting a possibly spend-capable token to an app no moderator approved. Also carries no spendGrantBasis, for the same reason as its sibling.',
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
/**
 * Axiom-sink events whose name mentions a mint at all — deliberately a SUBSTRING match,
 * not an anchored suffix.
 *
 * An anchored `/(^|[.-])mint$/` was ESCAPABLE BY SPELLING in the one direction the
 * ledger exists to cover. `blocks.dev-token.extra-mint` was caught, but an Axiom-ONLY
 * `blocks.dev-token.minted-extra` slipped through with the whole suite green — and
 * Axiom-only is precisely the unreadable case, because a both-sinks event always trips
 * the unfiltered `MIRRORS` equality no matter how it is spelled.
 *
 * Widening discards nothing today: the entire non-test `src/` tree contains exactly
 * FIVE `log?.info('…')` calls IN CODE and all five are these events, so the filter is not
 * protecting the ledger from unrelated log lines. (A bare grep reports six — the extra
 * hit is prose inside a docblock, which `code()` strips and which lacks the quoted first
 * argument this regex requires.) If an unrelated event ever legitimately contains "mint",
 * add it to the ledger or tighten this with a stated reason — do not silently re-anchor.
 */
const AXIOM_MINTS = emits(AXIOM_RE).filter(([name]) => /mint/i.test(name));

const LEDGER_NAMES = Object.keys(MINT_AUDIT_LEDGER).sort();

describe('mint-audit stdout-mirror call-site ledger (#3715)', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk / a regex that matches nothing would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    //
    // The bound is >3000 against a measured 3,563 non-test .ts/.tsx files under src/
    // (2026-08). It was >500, which would have passed having silently lost 85% of the
    // tree — a threshold that cannot fail is not a control. Kept well below the real
    // count so ordinary file churn does not make this flap; raise it if it ever does.
    expect(FILES.length).toBeGreaterThan(3000);
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
      'these mint-audit events reach Axiom but have NO stdout mirror — they are invisible to the stdout-scraped log store, so there is no short-window (~72h) forensic copy to read at incident time. Add emitMintAuditToStdout beside the req.log call. (NOTE: this does NOT affect the #3715 30-day gate, which is read from Axiom.)'
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

  it('the gate-bearing / audit-only split matches the SOURCE, not just the prose', () => {
    // Finding 4: only 3 of the 5 events feed the #3715 gate, and nothing in the code
    // said so. This pins the split to reality so the prose above cannot drift from it:
    // a gate-bearing event's file must actually mention spendGrantBasis, and an
    // audit-only event's file must NOT.
    //
    // LIMITATION, stated rather than hidden: the check is FILE-granular, which is only
    // sufficient because the split happens to fall exactly along file lines today (all
    // three bearer mints in dev-token.ts, both tunnel mints in block-tokens/index.ts).
    // If a gate-bearing and an audit-only event ever share a file, this must become a
    // per-call-site check.
    const gateBearing = Object.entries(MINT_AUDIT_LEDGER).filter(
      ([, e]) => e.kind === 'gate-bearing'
    );
    const auditOnly = Object.entries(MINT_AUDIT_LEDGER).filter(([, e]) => e.kind === 'audit-only');
    // Positive control: both groups are non-empty, so neither loop is vacuous.
    expect(gateBearing.length).toBe(3);
    expect(auditOnly.length).toBe(2);

    for (const [name, e] of gateBearing) {
      const src = CODE.get(e.file)!;
      expect(src, `${name} is gate-bearing, so ${e.file} must emit spendGrantBasis`).toContain(
        'spendGrantBasis'
      );
      expect(src, `${name} is gate-bearing, so ${e.file} must emit requestBudgetedSpend`).toContain(
        'requestBudgetedSpend'
      );
    }
    for (const [name, e] of auditOnly) {
      const src = CODE.get(e.file)!;
      expect(
        src,
        `${name} is audit-only, but ${e.file} mentions spendGrantBasis — either the event became gate-bearing (update kind) or the field leaked in`
      ).not.toContain('spendGrantBasis');
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
