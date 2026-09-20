import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { enclosingDecl } from '~/test-utils/routerSourceRegions';

/**
 * NO SUBMIT GATE READS `claims.buzzBudget` DIRECTLY — every one of them goes
 * through `blockPerCallBudget`.
 *
 * ── WHY THE INDIRECTION IS WORTH A GUARD WHEN IT CHANGES NO VALUE ───────────
 * `blockPerCallBudget` returns `claims.buzzBudget` on both of its
 * `pricesAuthorFee` classifications, so routing the gates through it alters
 * nothing today. What it buys is a single place where a future ceiling decision
 * can be made KNOWING WHICH GATE IS ASKING — and that distinction is a money
 * question, because the four gates are not interchangeable:
 *
 *   - two of them add the per-generation author fee into the value they compare;
 *   - two do not, and on the pass-through path the value that clears the gate is
 *     the value reserved and the value the terminal settle BILLS.
 *
 * A ceiling raised above what the app's manifest declared is therefore spendable
 * viewer Buzz on the second pair, and the manifest schema describes that declared
 * number to authors as a safety ceiling against a compromised app. A gate that
 * reads the claim directly is outside whatever decision gets made here, and that
 * is the drift this file exists to make impossible.
 *
 * ── WHY IT IS STRUCTURAL RATHER THAN SPELLED, AND WHAT THAT COST ────────────
 * 🔴 THE PREVIOUS VERSION OF THIS LEDGER WAS SPELLED, AND THE EXACT DEFECT IT
 * NAMED SURVIVED IT. It asserted `router.match(/> claims\.buzzBudget\b/g)` was
 * empty — a check on ONE literal spelling of one comparison operator in ONE file.
 * This mutant passed the entire suite:
 *
 *     - if (ceiling > perCallBudget)
 *     + if (ceiling > (claims.buzzBudget ?? perCallBudget))
 *
 * on the fee-free pass-through gate, which then reserves and bills against the
 * raw claim. The parenthesis alone defeated the regex; so would `>=`, `<`, `??`,
 * or hoisting the claim into a local first.
 *
 * So this inverts the test: EVERY occurrence of `claims.buzzBudget` in production
 * source is a violation unless it matches one of the ALLOWED forms enumerated
 * below, each carrying its reason. A new spelling is a violation by default
 * rather than by enumeration, which is the only direction that can be complete.
 *
 * ── WHY THE CORPUS IS THE WHOLE TREE ────────────────────────────────────────
 * 🔴 THE PREVIOUS VERSION READ `blocks.router.ts` AND NOTHING ELSE, so a budget
 * gate added in any other module was invisible to every count it took. Every
 * production `.ts`/`.tsx` under `src/` is scanned here. Test files are excluded:
 * a fixture is free to spell a claims bag any way it likes, and a ledger that
 * fails on someone else's test data is a ledger people delete.
 *
 * ── WHY IT IS WHITESPACE-INDEPENDENT ────────────────────────────────────────
 * 🔴 THE PREVIOUS VERSION MATCHED A SINGLE-LINE SPELLING OF THE CALL, so a fifth
 * gate wrapped across lines by prettier (printWidth 100) left its counts reading
 * 2 and 2 and passed green. Call sites here are found by balanced-paren
 * extraction and normalised before matching, so line breaks and a trailing comma
 * cannot hide one.
 *
 * ── WHY THIS FILE LIVES HERE ────────────────────────────────────────────────
 * `no-lint-rules-script-drift` scans only `src/server/services/__tests__` for
 * only this `no-*.test.ts` name shape. A guard of this class parked beside the
 * module it protects is invisible to that ratchet and is not run by the fast
 * `pnpm run test:lint-rules` selector — it would surface only in a full unit
 * suite, minutes later, in a file nobody was looking at.
 */

const SRC = path.resolve(__dirname, '../../..');

/** The claim this ledger governs. */
const CLAIM = 'claims.buzzBudget';

/**
 * Blank out every comment, preserving byte offsets and newlines so a violation's
 * line number survives.
 *
 * 🔴 PROSE MUST NOT BE ABLE TO TURN THIS RED. Half the files in the corpus
 * legitimately discuss `claims.buzzBudget` in a doc comment — this file does too
 * — and a ledger a comment can fail is a ledger someone loosens until it cannot
 * fail at all.
 *
 * A backslash always consumes the following character, in every context, so an
 * escaped slash inside a regex literal (`/\/\//`) cannot be mistaken for the
 * start of a line comment. That is the one case where a naive stripper would eat
 * real code — the fail-OPEN direction, which is why it is handled rather than
 * assumed. The positive controls below are what prove the stripper did not eat
 * anything: they assert the real allowed forms are still FOUND after stripping.
 */
function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === quote) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * THE ALLOWED FORMS — the complete list of ways production code may name this
 * claim. Anything else is a violation, including a shape that is obviously
 * harmless: the point is that the SET is closed, so a new reader has to add an
 * entry and say why rather than inventing a spelling that slips past a pattern.
 *
 * `files` scopes a form to the modules entitled to it, so the helper's own return
 * cannot license the same line inside a gate.
 */
type AllowedForm = {
  name: string;
  /** Matched against comment-blanked source; `\s+` tolerates prettier wrapping. */
  re: RegExp;
  /** Repo-relative paths (from `src/`) allowed to carry this form. */
  files: string[];
  /** How many occurrences exist today, across all allowed files. */
  count: number;
  why: string;
};

const ALLOWED_FORMS: AllowedForm[] = [
  {
    name: 'presence / positivity pre-check',
    // `typeof claims.buzzBudget !== 'number'`, optionally with the
    // `|| claims.buzzBudget <= 0` positivity leg of the same condition.
    re: /typeof\s+claims\.buzzBudget\s*!==\s*'number'(?:\s*\|\|\s*claims\.buzzBudget\s*<=\s*0)?/g,
    files: ['server/routers/blocks.router.ts', 'server/middleware/block-scope.middleware.ts'],
    count: 6,
    why:
      'Asks whether a budget was minted at all, and rejects a non-positive one. It compares ' +
      'the claim against no price, so it cannot be the site where a ceiling decision is ' +
      'skipped — and every gate needs it before the comparison the helper owns.',
  },
  {
    name: "the helper's own return",
    re: /return\s+claims\.buzzBudget;/g,
    files: ['server/middleware/block-scope.middleware.ts'],
    count: 1,
    why:
      '`blockPerCallBudget` is the one function entitled to read the claim for a gate. This ' +
      'is the read every gate is routed through.',
  },
  {
    name: 'the single mint-site write',
    re: /claims\.buzzBudget\s*=\s*input\.buzzBudget;/g,
    files: ['server/services/block-token.service.ts'],
    count: 1,
    why:
      'The one place the claim is WRITTEN. `BlockTokenService.sign` is the only block-token ' +
      'signer, so pinning this at exactly one occurrence is the single-writer property: a ' +
      'second mint computing a budget inline would land here as a violation rather than as a ' +
      'silent second definition of what the claim means. It is also the site any future ' +
      'ceiling change would be tempted to edit — which is why it is enumerated rather than ' +
      'left to a pattern.',
  },
  {
    name: 'read-surface projection',
    re: /buzzBudget:\s*claims\.buzzBudget\s*\?\?\s*null/g,
    files: ['server/routers/blocks.router.ts', 'pages/api/v1/blocks/me.ts'],
    count: 2,
    why:
      'The two doors that REPORT the number to the block (`blocks.getMyViewer` and ' +
      '`/api/v1/blocks/me`) — a projection onto a response body, not a comparison against a ' +
      'price. They are pinned to each other by ' +
      '`src/server/routers/__tests__/blocks.router.me-parity.test.ts`. If the minted claim ever ' +
      'stops being the number an app may price a generation at, these are the two sites that ' +
      'have to be revisited in the same commit.',
  },
];

/** Every production `.ts`/`.tsx` under `src/`, tests excluded. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !full.includes(`${path.sep}__tests__${path.sep}`)
    )
      out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const sourceFiles = walk(SRC);

/** `<file, comment-blanked source>` for every file that names the claim at all. */
const scanned = sourceFiles
  .map((f) => ({ file: rel(f), code: blankComments(readFileSync(f, 'utf8')) }))
  .filter((f) => f.code.includes(CLAIM));

/**
 * Remove every ALLOWED occurrence from a file, preserving offsets, and return
 * what is left over plus a per-form tally of what was removed.
 */
function residualReads(file: string, code: string) {
  let remaining = code;
  const removed: Record<string, number> = {};
  for (const form of ALLOWED_FORMS) {
    if (!form.files.includes(file)) continue;
    remaining = remaining.replace(form.re, (m) => {
      removed[form.name] = (removed[form.name] ?? 0) + 1;
      return m.replace(/[^\n]/g, ' ');
    });
  }

  const violations: string[] = [];
  for (let at = remaining.indexOf(CLAIM); at !== -1; at = remaining.indexOf(CLAIM, at + 1)) {
    const line = remaining.slice(0, at).split('\n').length;
    const text = remaining.split('\n')[line - 1].trim();
    violations.push(`${file}:${line}  ${text}`);
  }
  return { violations, removed };
}

/** Every `blockPerCallBudget(...)` call site in the corpus, braces balanced. */
function perCallBudgetSites(code: string): string[] {
  const sites: string[] = [];
  const opener = 'blockPerCallBudget(';
  for (let start = code.indexOf(opener); start !== -1; start = code.indexOf(opener, start + 1)) {
    // Skip the declaration itself — `export function blockPerCallBudget(`.
    if (/function\s+$/.test(code.slice(Math.max(0, start - 20), start))) continue;
    let depth = 0;
    let i = start + opener.length - 1;
    for (; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // Normalised so prettier line-wrapping cannot change what a site looks like.
    sites.push(code.slice(start, i + 1).replace(/\s+/g, ' '));
  }
  return sites;
}

const callSitesByFile = sourceFiles
  .map((f) => ({ file: rel(f), sites: perCallBudgetSites(blankComments(readFileSync(f, 'utf8'))) }))
  .filter((f) => f.sites.length > 0);

describe('the instrument itself', () => {
  it('walks the tree and reaches the directories this ledger reasons about', () => {
    // A walk that reached one top-level directory would make every assertion
    // below vacuous rather than red, and a token floor like 500 would not see it.
    expect(sourceFiles.length).toBeGreaterThan(3000);
    for (const dir of ['server/', 'pages/', 'components/']) {
      expect(sourceFiles.some((f) => rel(f).startsWith(dir))).toBe(true);
    }
  });

  it('blanks comments without eating code (positive + negative control)', () => {
    const sample = [
      'const a = claims.buzzBudget; // claims.buzzBudget in a line comment',
      '/* claims.buzzBudget in a block comment */',
      'const slash = /\\/\\//; const b = claims.buzzBudget;',
      "const s = '// claims.buzzBudget in a string';",
    ].join('\n');
    const blanked = blankComments(sample);

    // NEGATIVE CONTROL — the two comment occurrences are gone…
    expect(blanked).not.toContain('in a line comment');
    expect(blanked).not.toContain('in a block comment');
    // …POSITIVE CONTROL — and three survive: the two real reads, including the
    // one after a regex literal containing an escaped `//` (the case a naive
    // stripper eats silently), plus the one inside a string literal. Strings are
    // skipped for COMMENT DETECTION only, never erased, so a claim named inside
    // one would be reported — the fail-CLOSED direction.
    expect((blanked.match(/claims\.buzzBudget/g) ?? []).length).toBe(3);
    // Offsets are preserved, so a reported line number is the real one.
    expect(blanked.split('\n')).toHaveLength(sample.split('\n').length);
    expect(blanked.length).toBe(sample.length);
  });

  it('reports a violation for a read no allowed form covers (negative control)', () => {
    // A ledger nobody has watched go red is a claim about its own regexes. This
    // is the F2 mutant's exact shape, and a hoisted local, fed in synthetically.
    const mutant = [
      "  if (typeof claims.buzzBudget !== 'number' || claims.buzzBudget <= 0) return;",
      '  if (ceiling > (claims.buzzBudget ?? perCallBudget)) return;',
      '  const b = claims.buzzBudget;',
    ].join('\n');
    const { violations } = residualReads('server/routers/blocks.router.ts', mutant);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('server/routers/blocks.router.ts:2');
    expect(violations[1]).toContain('server/routers/blocks.router.ts:3');
  });

  it('finds the call sites it counts (positive control)', () => {
    expect(callSitesByFile.length).toBeGreaterThan(0);
    expect(callSitesByFile.flatMap((f) => f.sites).length).toBeGreaterThan(0);
  });
});

describe('no production code reads the per-call budget claim outside the allowed forms', () => {
  it('every occurrence in the tree matches an allowed form', () => {
    const violations = scanned.flatMap((f) => residualReads(f.file, f.code).violations);
    expect(
      violations,
      'These read `claims.buzzBudget` in a shape no ALLOWED_FORMS entry covers. A submit gate ' +
        'must compare against `blockPerCallBudget(claims, { pricesAuthorFee })` instead — that ' +
        'is the one place a ceiling decision can be made knowing whether the compared value ' +
        'carries the author fee. If the read is genuinely not a gate, add a form above WITH ITS ' +
        'REASON rather than widening an existing pattern.'
    ).toEqual([]);
  });

  it('every allowed form is still exercised, at its stated count', () => {
    // Fails on SHRINK as well as growth: a form whose occurrences vanished is a
    // stale exemption, and — more importantly — a form that silently stopped
    // matching would make the test above pass by removing nothing.
    const tally: Record<string, number> = {};
    for (const f of scanned) {
      for (const [name, n] of Object.entries(residualReads(f.file, f.code).removed)) {
        tally[name] = (tally[name] ?? 0) + n;
      }
    }
    for (const form of ALLOWED_FORMS) {
      expect(
        tally[form.name] ?? 0,
        `allowed form "${form.name}" — update its count or drop it`
      ).toBe(form.count);
    }
  });

  it('names no file that no longer carries the form it was allowed for', () => {
    const stale: string[] = [];
    for (const form of ALLOWED_FORMS) {
      for (const file of form.files) {
        const entry = scanned.find((f) => f.file === file);
        form.re.lastIndex = 0;
        if (!entry || !form.re.test(entry.code)) stale.push(`${form.name} → ${file}`);
      }
    }
    expect(stale, 'drop these from ALLOWED_FORMS[].files').toEqual([]);
  });
});

describe('the four submit gates are routed through one helper', () => {
  const sites = callSitesByFile.flatMap((f) => f.sites);

  it('every call site declares which kind of gate it is', () => {
    // 🔴 A GATE WITHOUT THE FLAG IS THE DEFECT THIS PINS. The parameter is
    // classification only and no branch reads it today, so a missing one is a
    // type error rather than a money bug right now — but it becomes load-bearing
    // the moment any ceiling decision lands behind it, and by then nobody will
    // re-derive which population each gate belongs to.
    for (const site of sites) expect(site).toMatch(/pricesAuthorFee:\s*(true|false)\b/);
  });

  it('the fee-pricing and fee-free populations are exactly the two known sets', () => {
    const pricing = sites.filter((s) => /pricesAuthorFee:\s*true\b/.test(s));
    const feeFree = sites.filter((s) => /pricesAuthorFee:\s*false\b/.test(s));

    // txt2img submit and the registry step price a fee; customComfy/recipe and
    // the pass-through step do not. Adding a gate means deciding which it is.
    expect(pricing).toHaveLength(2);
    expect(feeFree).toHaveLength(2);
    expect(sites).toHaveLength(4);
  });

  it('the fee-pricing population agrees with the RESERVING fee call sites', () => {
    // 🔴 THE RELATIONSHIP, not a component: a path that GROWS a fee without
    // flipping its flag, or flips a flag without wiring a fee, moves exactly one
    // of these two numbers. Both are read from the same file so neither can be
    // satisfied by the other's population.
    //
    // 🔴 THE POPULATION IS RESERVING QUOTES, NOT ALL QUOTES — AND COUNTING ALL OF
    // THEM IS A BUG THIS GUARD BRIEFLY HAD. `quoteBlockAuthorFee` is now called
    // from the two ESTIMATE arms as well, to DISCLOSE the fee in the price the
    // block is shown. Those quotes reserve nothing and gate nothing, so they have
    // no `blockPerCallBudget` call to flip a flag on: a raw count of quote sites
    // compared against the `pricesAuthorFee: true` count is comparing two
    // different populations and can only be made green by breaking one of them.
    // `pricesAuthorFee` classifies BUDGET GATES, and only a submit path has one.
    //
    // The split is by ENCLOSING DECLARATION, which is the same discriminator
    // `no-divergent-author-fee-base.test.ts` ledgers each site's role with — so
    // a disclosing quote that moved into a submit path (or the reverse) is red in
    // both files rather than silently re-partitioned here.
    const router = blankComments(
      readFileSync(path.join(SRC, 'server/routers/blocks.router.ts'), 'utf8')
    );
    // ANY `*Procedure` spelling — the router also declares `moderatorProcedure`
    // and `appDeveloperProcedure` handlers, and skipping them resolves an offset
    // inside one to the PREVIOUS public/protected procedure. Kept byte-identical
    // to `no-divergent-author-fee-base.test.ts`'s `PATH_DECL` on purpose: the
    // comment below claims the two guards share a discriminator, and two copies
    // that can drift would make that claim false the first time one is fixed.
    // 🔴 ONE DISCRIMINATOR, SHARED — this test's own comment above claims the
    // split "is the same discriminator `no-divergent-author-fee-base.test.ts`
    // ledgers each site's role with". Two independently-maintained copies of a
    // regex cannot support that sentence: the first person to fix one leaves the
    // other wrong and both stay green. `enclosingDecl` is that one copy.
    const quoteOwners = [...router.matchAll(/quoteBlockAuthorFee\(\{/g)].map((m) =>
      enclosingDecl(router, m.index)
    );
    expect(quoteOwners.length, 'no fee quotes found — the matcher is wrong').toBeGreaterThan(0);
    // Positive control on the SPLIT itself: a discriminator that resolved
    // everything to one bucket would make the comparison below vacuous. Both
    // buckets must be non-empty, which is a fact about today's router and is
    // exactly what makes the number on the left meaningful.
    const reserving = quoteOwners.filter((owner) => owner.startsWith('submit'));
    const disclosing = quoteOwners.filter((owner) => owner.startsWith('estimate'));
    expect(reserving.length, 'no reserving quote — the discriminator is wrong').toBeGreaterThan(0);
    expect(disclosing.length, 'no disclosing quote — the discriminator is wrong').toBeGreaterThan(
      0
    );
    expect(
      reserving.length + disclosing.length,
      'a fee quote sits in neither a submit nor an estimate path'
    ).toBe(quoteOwners.length);

    expect(reserving).toHaveLength(2);
    expect(
      (router.match(/pricesAuthorFee:\s*true\b/g) ?? []).length,
      'a submit path priced a fee without flipping its gate flag, or the reverse'
    ).toBe(reserving.length);
  });
});
