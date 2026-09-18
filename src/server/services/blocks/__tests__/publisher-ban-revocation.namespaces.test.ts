import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';
import { deriveScopeFromInstanceId } from '~/server/schema/blocks/attribution.schema';

/**
 * 🔴 SEAM GUARD: the set of blockInstanceId NAMESPACES a publisher ban must reach.
 *
 * The behavioural suite (`services/__tests__/ban-revokes-block-instances.test.ts`)
 * proves the writer marks the ids it is given. What no behavioural test can express is
 * the property that decayed here once already and shipped: that the writer's notion of
 * "every live instance" is CLOSED over the namespaces the guards actually see.
 *
 * The first version of `revokeBlockInstancesForPublisher` selected
 * `blockInstanceId: { not: null }` and covered exactly ONE of five. Its own comment
 * said a blanket subscription "has no minted token keyed to a stored one" — true, and
 * irrelevant, because the token is keyed to the SYNTHESISED id and
 * `isRevoked(claims.blockInstanceId)` compares that string verbatim. Four namespaces
 * went unrevoked while the guard comment, the service docblock and the commit message
 * all said "every live instance of every block the banned user OWNS". Nothing in the
 * compiler, and nothing in a fixture built from the same wrong assumption, could see
 * it.
 *
 * So this pins the RELATIONSHIP rather than the component: the writer's namespace set
 * against `deriveScopeFromInstanceId`, which is the canonical PARSER
 * (`~/server/schema/blocks/attribution.schema`) and the thing
 * `BlockRegistry.resolveBlockInstance` dispatches in lockstep with. It fails when the
 * parser learns a prefix the writer does not emit (GROWTH — a new surface mints tokens
 * a ban cannot reach) and when the writer emits one the parser does not know (SHRINK,
 * or a typo'd prefix — a marker under an id no token ever carries refuses nothing and
 * reads as coverage).
 */

const WRITER = 'src/server/services/blocks/publisher-ban-revocation.service.ts';

/**
 * Every prefix the writer must be able to produce, with the source that produces it.
 * `mbi_` is deliberately absent from the emitted set: it is a legacy STORED value read
 * straight off the column, not a prefix this writer ever constructs.
 */
const NAMESPACES = [
  { prefix: 'bki_', synthesised: false, source: 'BlockUserSubscription.blockInstanceId (pinned)' },
  { prefix: 'mbi_', synthesised: false, source: 'BlockUserSubscription.blockInstanceId (legacy)' },
  { prefix: 'bus_pub_', synthesised: true, source: 'blanket publisher_all_my_models subscription' },
  { prefix: 'bus_view_', synthesised: true, source: 'viewer_personal subscription' },
  { prefix: 'pdb_', synthesised: true, source: 'PlatformDefaultBlock promotion' },
  { prefix: 'page_', synthesised: true, source: 'the <slug>.civit.ai full-page surface' },
] as const;

const SOURCE = readFileSync(join(process.cwd(), WRITER), 'utf8');

/** The writer's own source with comments stripped, so a prefix NAMED in prose but never
 * constructed cannot satisfy the emission check below. That is the exact failure this
 * guard exists for — the broken version described all five namespaces accurately in a
 * comment while emitting one. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the ban writer is closed over every blockInstanceId namespace', () => {
  it('POSITIVE CONTROL: the comment stripper left real code behind', () => {
    // Without this, every "emits X" assertion below could pass vacuously on an empty
    // string, or fail vacuously on a stripper that ate the file.
    expect(CODE).toContain('revokeBlockInstancesForPublisher');
    expect(CODE).toContain('BlockRevocation.revokeInstance');
    // …and it really did remove the prose, so the checks below are about code.
    expect(SOURCE).toContain('THE THIRD `revokeInstance` WRITER');
    expect(CODE).not.toContain('THE THIRD');
  });

  it('NEGATIVE CONTROL: a prefix that exists nowhere is not claimed as emitted', () => {
    expect(CODE).not.toContain('nosuchprefix_');
    expect(deriveScopeFromInstanceId('nosuchprefix_abc')).toBeNull();
  });

  it.each(NAMESPACES.map((n) => [n.prefix, n.source] as const))(
    'the canonical parser still recognises %s (%s)',
    (prefix) => {
      expect(
        deriveScopeFromInstanceId(`${prefix}01JEXAMPLE`),
        `deriveScopeFromInstanceId no longer maps "${prefix}" to a scope — either the ` +
          `namespace was retired (drop it here) or the parser regressed`
      ).not.toBeNull();
    }
  );

  it.each(NAMESPACES.filter((n) => n.synthesised).map((n) => [n.prefix, n.source] as const))(
    'the writer CONSTRUCTS %s (%s)',
    (prefix) => {
      expect(
        CODE.includes(`\`${prefix}$`),
        `${WRITER} never builds a "${prefix}" id, so a publisher ban leaves every ` +
          `${prefix}* instance authenticating until its token expires. Emit it, or ` +
          `remove it from NAMESPACES with a stated reason.`
      ).toBe(true);
    }
  );

  it('reads the stored column for the non-synthesised namespaces', () => {
    // The two stored prefixes are never constructed — they are read off
    // `blockInstanceId`. Assert the read exists, or "we cover bki_" would rest on
    // nothing at all.
    expect(CODE).toContain('blockInstanceId: true');
    expect(CODE).toContain('row.blockInstanceId');
  });

  /**
   * 🔴 GROWTH, the direction that shipped the defect. The parser is the surface that
   * learns about a new install shape first — `resolveBlockInstance` and
   * `deriveScopeFromInstanceId` move together — so a sixth prefix appearing there with
   * no entry here means a ban has a hole nobody wrote down.
   */
  it('the parser knows no prefix this ledger has not enumerated', () => {
    const parser = readFileSync(
      join(process.cwd(), 'src/server/schema/blocks/attribution.schema.ts'),
      'utf8'
    );
    const body = parser.slice(parser.indexOf('export function deriveScopeFromInstanceId'));
    const found = [...body.matchAll(/startsWith\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
    expect(
      found,
      'deriveScopeFromInstanceId dispatches on a prefix set this guard does not know. A ' +
        'new install surface mints tokens the ban writer cannot revoke until it is ' +
        'added to NAMESPACES and emitted.'
    ).toEqual(NAMESPACES.map((n) => n.prefix).sort());
  });

  /**
   * 🔴 SHRINK / TYPO. A marker written under an id no token ever carries refuses
   * nothing, and is indistinguishable from coverage in every behavioural test — the
   * fixture would simply assert the id the writer invented.
   */
  it('every prefix the writer constructs is one the parser recognises', () => {
    const emitted = [...CODE.matchAll(/`([a-z_]+)\$\{/g)].map((m) => m[1]);
    expect(
      emitted.length,
      'the writer constructs no ids at all — this check is inert'
    ).toBeGreaterThan(0);
    for (const prefix of emitted) {
      expect(
        deriveScopeFromInstanceId(`${prefix}01JEXAMPLE`),
        `${WRITER} writes a marker under "${prefix}*", which deriveScopeFromInstanceId ` +
          `does not recognise — no token carries that id, so the marker refuses nothing`
      ).not.toBeNull();
    }
  });
});

/**
 * 🔴 THE "EXACTLY THREE PRODUCTION CALL SITES" SENTENCE, PINNED MECHANICALLY.
 *
 * That enumeration is currently restated in five files — `block-scope.middleware.ts`,
 * `block-revocation.service.ts`, `blocks/block-bridge-auth.service.ts`,
 * `blocks/scope-grant.service.ts`, `routers/apps.router.ts` — and those same comments
 * record that it has already been WRONG TWICE, in both directions: it claimed a ban writer
 * that did not exist, then denied one after it did. A sentence with that history, cited by
 * other files as authoritative and held by nothing but prose, is going to be wrong a third
 * time. This is the cheap thing that makes the third time a red test instead of a false
 * claim a reader acts on.
 */
describe('the revokeInstance call-site ledger', () => {
  const CALL_SITE_LEDGER: Record<string, string> = {
    'src/server/services/block-registry.service.ts':
      'TWO sites — uninstallFromModel and toggleEnabled(false). In both the marker is a ' +
      'SIDE EFFECT of a different, user-visible operation (the install goes away or is ' +
      'switched off), and both write the default `install` cause, which clearInstance is ' +
      'allowed to clear.',
    'src/server/services/blocks/publisher-ban-revocation.service.ts':
      'ONE site — revokeBlockInstancesForPublisher, reached from toggleBan. The only ' +
      'caller whose PURPOSE is revocation, the only one that writes the `ban` cause, and ' +
      'the only one that leaves the installs themselves untouched.',
  };

  const SCAN_ROOTS = ['src/server', 'src/pages'];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...walk(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        out.push(full);
      }
    }
    return out;
  }

  const FILES = SCAN_ROOTS.flatMap((r) => walk(join(process.cwd(), r)));
  const CALLERS = FILES.filter((f) =>
    /BlockRevocation\.revokeInstance\s*\(/.test(readFileSync(f, 'utf8'))
  )
    .map((f) => relative(process.cwd(), f).split(sep).join('/'))
    .sort();

  it('POSITIVE CONTROL: the walk enumerates a real population and the pattern can match', () => {
    // A broken walk or a pattern that matches nothing makes the equality below vacuous.
    expect(FILES.length).toBeGreaterThan(300);
    expect(CALLERS.length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a definitely-absent call does not match', () => {
    const bogus = FILES.filter((f) =>
      /BlockRevocation\.revokeNoSuchThing\s*\(/.test(readFileSync(f, 'utf8'))
    );
    expect(bogus).toEqual([]);
  });

  it('every production caller is ledgered, with its cause decision (fails on GROWTH and SHRINK)', () => {
    expect(
      CALLERS,
      'the set of files calling BlockRevocation.revokeInstance changed. Five files state ' +
        'this enumeration in prose and are cited as the authority on it — update the ' +
        'ledger here AND those comments in the same commit, or the next reader acts on a ' +
        'claim that is false.'
    ).toEqual(Object.keys(CALL_SITE_LEDGER).sort());
  });
});
