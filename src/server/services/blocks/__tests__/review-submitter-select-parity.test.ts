import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { reviewUserChipSelect } from '~/server/selectors/review-user-chip.selector';

/**
 * THE SEAM BETWEEN EVERY MODERATOR REVIEW SURFACE'S USER CHIP.
 *
 * The `/apps/review` queue (on-site AND off-site rows, interleaved in ONE list), the
 * per-submission page, and the prior-versions modal all render the SAME `UserAvatar` for the
 * submitter and the reviewer. That component reads `username`, `image`, `deletedAt`,
 * `profilePicture` and `cosmetics` off whatever object it is handed — so the surfaces agree
 * only while their selects do.
 *
 * 🔴 THIS FILE USED TO BE A 230-LINE PARITY SCAN, AND DELETING THAT WAS THE FIX.
 *
 * The literal `{ id, username, deletedAt, image }` was spelled inline at NINE sites in
 * `publish-request.service.ts` plus one in `offsite-listing.service.ts`, and the scan existed
 * to assert the ten agreed. They did not: `deletedAt` reached the five `submittedBy` ones a
 * whole round before the four `reviewedBy` ones, and the off-site chip after both — so for a
 * while the queue rendered a closed account as `[deleted]` on an on-site row and as a live,
 * linked profile on the off-site row directly beneath. A predicate open-coded at ten sites is
 * typically wrong at most of them in the same direction, and a scan can only report that
 * after the fact.
 *
 * There is now ONE declaration — `reviewUserChipSelect` — so parity is an identity rather
 * than a text property. What survives is the smaller question the const cannot answer by
 * itself: does it still carry what the chip BRANCHES on, and has a NARROWER copy appeared?
 *
 * ⚠️ The scan is not "replaced by types". A Prisma select is structurally typed, so a
 * narrower literal is still assignable — nothing in the type system objects to someone
 * writing the four fields out again, minus one. That is what the third case checks.
 */

const SERVICE_FILES = [
  'src/server/services/blocks/publish-request.service.ts',
  'src/server/services/blocks/offsite-listing.service.ts',
  'src/server/services/blocks/app-listing.service.ts',
] as const;

/**
 * User chips in the corpus that are DELIBERATELY narrow, keyed on FILE, CONTAINER and OWNER.
 *
 * 🔴 A THIRD ENTRY WAS DELETED RATHER THAN RE-KEYED — which is the finding worth carrying (two
 * remain, below). It exempted the collaborator-allowlist `user.findMany`, and the key it matched on
 * was the owner resolver's "I could not tell" sentinel. Measured: that admitted EVERY bare
 * `select: {` on a Prisma query, in all three files, including the service this whole arc is
 * about. A guard that fails open on the commonest shape is worse than no guard, because it
 * reads as coverage. The fix was not a better key — it was to make that chip stop being
 * narrow (its `where` already excludes deleted rows, so the column costs nothing), and delete
 * the entry.
 *
 * 🔴 `file` IS PART OF THE KEY. Without it, the surviving `user` entry — justified for the
 * listings table — would exempt any property called `user` in any corpus file, including
 * `publish-request.service.ts`.
 *
 * Adding an entry is a decision someone has to write down; the equality below fails if one
 * goes stale, so an exemption cannot outlive its reason either.
 */
const DELIBERATELY_NARROW: ReadonlyArray<{
  file: string;
  container: string;
  owner: string;
  why: string;
}> = [
  {
    file: 'src/server/services/blocks/app-listing.service.ts',
    container: 'moderationListingSelect',
    owner: 'user',
    why: "the moderation listings table's own creator cell — plain text, a different screen",
  },
  {
    file: 'src/server/services/blocks/app-listing.service.ts',
    container: 'listingHydrateSelect',
    owner: 'user',
    why: 'the PUBLIC store listing creator. The default path hands `SmartCreatorCard` only `{ id }` and refetches through the public `user.getCreator` proc; the `preview` path (its own `CreatorChip`) renders the chip directly, and a closed account drops out of it only INCIDENTALLY — `deleteUser` nulls `username` in the same transaction as `deletedAt`, and the chip skips username-less rows. That is the scrub doing the work, not a `deletedAt` branch, which is the same incidental-not-a-filter distinction `app-listing.service.ts` draws about its collaborator chip — and THERE it was judged not good enough, so that select carries `deletedAt` and this one still does not. Bounded, not closed. SEVEN writers set `username` in APPLICATION code (enumerated over Prisma `.user.{update,updateMany,upsert,create,createMany}`, kysely `updateTable`/`insertInto` on the User table, and raw SQL, across `src/`, `apps/` and `packages/`; add the one-shot 2023 migration under `packages/civitai-db-schema/prisma/migrations/` and a reader gets eight. Four earlier versions of this sentence said four, then six, and miscounted in both directions). TWO of them write `deletedAt`: `deleteUser` sets it and scrubs `username` in the same transaction, and `restoreUser` clears it alongside a username write in one transaction — so neither can leave a row deleted-and-named. Of the rest, the hazard is exactly one: `forceUpdateUserIdentity`, a moderator endpoint whose gating is ACTOR-only, so its arbitrary `userId` matches a soft-deleted row. The others are unreachable for a closed account, for DIFFERENT reasons: `updateUserHandler` is a `guardedProcedure` (so `isAuthed` rejects `user.deletedAt`) and throws unless `id === ctx.user.id` — note that is the HANDLER, not `updateUserById`, which has eleven call sites including an unsessioned cron, only this one passing `username`; `completeOnboardingHandler` writes `where: { id }` off a `ProtectedContext`; `assignUsername` is in the auth app and runs before a session exists, so neither applies and it is safe structurally instead — both call sites sit inside an `if (!userId)` fresh-INSERT branch; `findOrCreateUser` in that same file is the seventh, and writes only the literal `null` on that same fresh INSERT. Widening this select is still the fix and is still a separate change',
  },
] as const;

/**
 * Every object literal in a service that names `username: true`, with the property it hangs
 * off and the fields it selects.
 *
 * 🔴 AN AST WALK, AND THE REGEX IT REPLACES WAS WORSE THAN THE GUARD IT CAME FROM — which is
 * the reason this is a rewrite and not a patch.
 *
 * The first version matched a NAME allowlist (`submittedBy|reviewedBy|submitter`), which a
 * hoisted `authorChip` walked straight past. The second anchored on the FIELD and recovered
 * the owner with a 120-character backward regex — closing that hole and opening a worse one:
 * when the lookbehind failed it returned a sentinel, `'<anonymous>'`, and the exemption
 * ledger then keyed on owner NAMES, so the resolver's "I could not tell" value doubled as a
 * blanket licence. Measured on the real corpus: `dbRead.user.findMany({ where, select: {…} })`
 * — the most ordinary way to add a narrow user projection — resolved to that sentinel and was
 * silently exempt. A guard that fails OPEN on the commonest shape is worse than no guard,
 * because it reads as coverage.
 *
 * `node.parent` on an `ObjectLiteralExpression` answers "which key does this hang off"
 * exactly, with no window, no sentinel and no type-name misattribution. 29 files in `src/`
 * already import `typescript` for precisely this kind of guard; this one should have from the
 * start. Comments and strings need no stripping either — the parser does not confuse prose
 * with code, which is the whole point of using it.
 */
type Chip = { file: string; container: string | null; owner: string | null; fields: string[] };

/**
 * 🔴 SPLIT FROM `userChips` SO THE WALK CAN BE FED PLANTED SOURCE. The previous version read
 * the file itself, which made the offender path impossible to control: measured, replacing
 * `offenders.push(...)` with a no-op left all four tests GREEN. The real corpus is compliant
 * by construction, so `offenders` is `[]` on every honest run and the branch never executes —
 * a guard whose only output is structurally unreachable. Taking text as a parameter is what
 * lets `judge` below be exercised against a chip that MUST be rejected.
 */
function chipsIn(rel: string, text: string): Chip[] {
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Chip[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // 🔴 ONLY `<field>: true` COUNTS — a Prisma SELECT, not any object that mentions a
      // username. Without this the walk also caught `creatorChip`'s RETURN PROJECTION
      // (`{ id: user.id, username: user.username, image: user.image }`), which is a different
      // thing with a different fix: it lives in no variable declaration, so it resolved to an
      // unnamed chip and read as an unguarded select. Narrowing to the select shape keeps the
      // guard's subject and its name the same thing. (That projection's own `deletedAt` gap
      // is recorded where it lives, in `app-listing.moderation.service.test.ts`.)
      const fields = node.properties
        .filter(ts.isPropertyAssignment)
        .filter((prop) => prop.initializer.kind === ts.SyntaxKind.TrueKeyword)
        .map((prop) =>
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
        )
        .filter(Boolean);
      if (fields.includes('username')) {
        out.push({ file: rel, ...identify(node), fields });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return out;
}

function userChips(rel: string): Chip[] {
  return chipsIn(rel, readFileSync(join(process.cwd(), rel), 'utf8'));
}

/**
 * The VERDICT, extracted so the real corpus and a planted chip go through the same code.
 *
 * 🔴 `matched` IS AN ARRAY, NOT A SET — and that is a fail-open fix, not a style choice.
 * `{file, container, owner}` is not unique per chip: `identify()` walks up to the first
 * variable declaration, so a `user:` nested three levels inside `moderationListingSelect`
 * resolves to the SAME key as the top-level one the ledger exempts. With a Set both chips
 * collapsed into one entry and the equality below could not see the second — measured, a
 * planted `appBlock: { select: { publisher: { select: { user: {…} } } } }` was silently
 * exempt. As an array, a key matching twice makes the equality 3-vs-2 and reds.
 */
function judge(rel: string, chips: Chip[]): { offenders: string[]; matched: string[] } {
  const offenders: string[] = [];
  const matched: string[] = [];
  for (const chip of chips) {
    if (chip.fields.includes('deletedAt')) continue;
    // 🔴 KEYED ON FILE, CONTAINER **AND** OWNER. Keying on the name alone let the `user` entry —
    // justified for the listings table — exempt any property called `user` in any of the
    // three files, including the service this whole arc is about.
    // 🔴 AN UNRESOLVABLE CHIP IS AN OFFENDER, NEVER AN EXEMPTION. Twice now the resolver's
    // failure value was a string that the ledger could name, and both times that silently
    // licensed a whole class. `null` is not in the ledger's domain, so it cannot.
    const entry =
      chip.owner === null || chip.container === null
        ? undefined
        : DELIBERATELY_NARROW.find(
            (e) => e.file === rel && e.container === chip.container && e.owner === chip.owner
          );
    if (entry) {
      matched.push(`${entry.file}::${entry.container}::${entry.owner}`);
      continue;
    }
    offenders.push(
      `${rel}: ${chip.container ?? '<unresolved>'}.${
        chip.owner ?? '<unresolved>'
      }: { ${chip.fields.join(', ')} }`
    );
  }
  return { offenders, matched };
}

/**
 * Where this literal lives: the enclosing top-level declaration, and the property it hangs
 * off. Either may be `null`.
 *
 * 🔴 `null` IS NOT A NAME, AND IT IS NEVER EXEMPTABLE — which is the third version of this
 * function and the second time the same mistake was made. v2 returned the string
 * `'<anonymous>'` when its regex lookbehind failed, and the exemption ledger keyed on owner
 * NAMES, so the resolver's "I could not tell" doubled as a blanket licence. v3 replaced the
 * regex with this AST walk and then fell back to the literal `'select'` — a different
 * spelling of the same hole, since `select` is a real key an exemption could name.
 *
 * The lesson is not "pick a better sentinel": it is that a resolver's failure value must not
 * live in the same domain as its success values. `null` cannot be typed into the ledger
 * (`owner: string`), so an unresolvable chip is structurally an offender. The only way to
 * silence one is to make it resolvable or to make it carry `deletedAt`.
 *
 * `container` distinguishes two chips that share an owner name — `app-listing.service.ts`
 * has a `user:` in `listingHydrateSelect` and another in `moderationListingSelect`, and a
 * ledger that cannot tell them apart grants one pass for two different reasons.
 */
function identify(node: ts.ObjectLiteralExpression): {
  container: string | null;
  owner: string | null;
} {
  let owner: string | null = null;
  let container: string | null = null;
  let current: ts.Node = node;

  for (let depth = 0; depth < 40; depth += 1) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) break;
    if (owner === null && ts.isPropertyAssignment(parent)) {
      if (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) {
        const name = parent.name.text;
        // Step through ONE `select:` wrapper so `x: { select: { … } }` reports `x`.
        if (name === 'select' && parent.parent && ts.isObjectLiteralExpression(parent.parent)) {
          current = parent.parent;
          continue;
        }
        owner = name;
      }
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      container = parent.name.text;
      if (owner === null) owner = parent.name.text;
      break;
    }
    current = parent;
  }
  return { container, owner };
}

/** Every object literal in a file — the walk's own liveness control. */
function objectLiterals(rel: string): number {
  const text = readFileSync(join(process.cwd(), rel), 'utf8');
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) n += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return n;
}

describe('the review user chip is one declaration', () => {
  test('🔴 it carries the fields `UserAvatar` actually BRANCHES on', () => {
    // `UserAvatar` falls back to initials from `username` and to `user.image` when there is
    // no `profilePicture` row, so those two plus `id` are the floor for the chip rendering at
    // all. `id` is additionally what the no-username branch shows (`#<id>`).
    //
    // 🔴 `deletedAt` IS REQUIRED, AND ITS ABSENCE WAS A LIVE DEFECT RATHER THAN A GAP.
    // `UserProfileLink` suppresses `linkToProfile` for a deleted account, and `Username`
    // renders "[deleted]" instead of a name — both read this field. Without it the value is
    // `undefined` ⇒ falsy ⇒ a DELETED submitter rendered as a live, linked account, on the
    // surface where who submitted a bundle is the fact being judged. A field that exists in a
    // DTO is not a guard; those are the consumers that BRANCH on it, which is why the floor
    // names it. The render itself is pinned in `ReviewSubmitterMeta.browser.test.tsx` and,
    // for both row kinds in one list, `UnifiedReviewList.deletedSubmitter.browser.test.tsx`.
    expect(reviewUserChipSelect).toEqual({
      id: true,
      username: true,
      deletedAt: true,
      image: true,
    });
  });

  test('🔴 it is `simpleUserSelect` MINUS `profilePicture` — an asserted relationship, not a coincidence', () => {
    // The repo's house chip is `simpleUserSelect`, and this one is deliberately one field
    // narrower: `profilePicture` is a NESTED select, so Prisma issues an extra batched query
    // against one of the largest tables in the database per list call — on three mod-queue
    // list paths, for a gain `UserAvatar` already falls back from.
    //
    // 🔴 ASSERTED RATHER THAN DERIVED. Writing `const { profilePicture, ...rest } =
    // simpleUserSelect` in the SOURCE would make a new field on the house chip propagate here
    // silently, onto exactly those list paths. Asserting it instead means a widening of
    // `simpleUserSelect` turns this case RED and forces someone to decide. That is the point.
    const { profilePicture, ...rest } = simpleUserSelect;
    expect(
      profilePicture,
      'the field this chip exists to omit must still be on the house chip'
    ).toBeDefined();
    expect(rest).toEqual(reviewUserChipSelect);
  });

  test('🔴 every user chip these services select carries `deletedAt` — whatever it is called', () => {
    // The failure this replaces the parity scan for: a narrower literal written out again at
    // a new call site. Prisma selects are structurally typed, so `{ id: true, username: true,
    // image: true }` is perfectly assignable — it just silently drops the branch.
    const offenders: string[] = [];
    const matched: string[] = [];
    for (const rel of SERVICE_FILES) {
      const verdict = judge(rel, userChips(rel));
      offenders.push(...verdict.offenders);
      matched.push(...verdict.matched);
    }
    expect(
      offenders,
      'a user chip without `deletedAt` renders a closed account as a live, linked profile'
    ).toEqual([]);

    // 🔴 THE EXEMPTIONS ARE ASSERTED, NOT MERELY ALLOWED. An entry whose chip has since been
    // widened — or deleted — is a stale licence to be narrow, and nothing else would notice.
    expect(
      matched.sort(),
      'every entry in DELIBERATELY_NARROW must correspond to EXACTLY ONE narrow chip'
    ).toEqual(DELIBERATELY_NARROW.map((e) => `${e.file}::${e.container}::${e.owner}`).sort());
  });

  test('🔴 POSITIVE CONTROL: the walk is live, exact, and CAN reject — including a near-exemption', () => {
    // (a) It reads real literals out of the real files. Deliberately NOT a count of user
    // chips: `publish-request.service.ts` legitimately has ZERO now (every chip reads the
    // shared const), so asserting a non-zero chip count would fail the moment the guard
    // started succeeding.
    for (const rel of SERVICE_FILES) {
      expect(objectLiterals(rel), `${rel} must yield object literals`).toBeGreaterThan(5);
      expect(
        readFileSync(join(process.cwd(), rel), 'utf8'),
        `${rel} must consume the shared select`
      ).toContain('reviewUserChipSelect');
    }

    // (b) 🔴 IT ACTUALLY REJECTS — the planted source goes through the SAME `chipsIn` + `judge`
    // the real assertion uses, so this drives the offender path rather than asserting a lookup
    // in the ledger array. The previous version checked only that these owners were absent
    // from `DELIBERATELY_NARROW`, which never called the walk at all: measured, replacing
    // `offenders.push(...)` with a no-op left every test in this file GREEN. The real corpus is
    // compliant, so `offenders` is `[]` on every honest run and this is the only case that can
    // ever observe the branch.
    //
    // Shapes covered: an EXEMPTED owner name (`user`) in a file with no such entry, so a
    // name-keyed ledger would wave it through; a plain property; a hoisted const with a
    // `select` wrapper and one without; and — the two the Set collapsed — a `user` NESTED
    // inside each exempted container, which resolves to the exempted container's own key.
    // 🔴 DERIVED FROM THE LEDGER, NOT SPELLED. An earlier version hardcoded
    // `listingHydrateSelect`, whose own `why` describes it as something to retire — and
    // measured, once that entry goes the file-half coverage goes silently with it: simulating
    // the retirement and then dropping `e.file === rel` gave 4/4 green again. Deriving the
    // container and owner from the live ledger means the probe follows whatever is exempt.
    expect(
      DELIBERATELY_NARROW.length,
      // Not a coverage guard: an empty ledger already fails loudly, as a TypeError on
      // `EXEMPT.container` — the first access in source order, and unconditional, since the
      // probes gate nothing. This only trades that for a sentence naming the cause.
      'the planted probes derive from the ledger; an empty one fails here rather than as a TypeError below'
    ).toBeGreaterThan(0);
    const EXEMPT = DELIBERATELY_NARROW[0];
    // The narrow shape this whole file is about, spelled nine times across the planted
    // sources. Named once so the property it OMITS is the thing a reader sees.
    const NARROW = 'id: true, username: true, image: true';
    // 🔴 EACH PROBE BELOW IS ONLY A PROBE WHILE THE LEDGER DOES NOT NAME ITS VALUE. Three
    // preconditions, identical but for the field, so they are one helper — the message still
    // names the field, so a failure stays attributable to the probe that went stale rather
    // than reading as "the guard broke".
    const probeUnnamed = (field: 'file' | 'container' | 'owner', value: string) =>
      expect(
        DELIBERATELY_NARROW.map((e) => e[field]),
        `the ${field} probe stops being a probe if the ledger ever names this ${field}`
      ).not.toContain(value);

    // 🔴 AN OWNER THE LEDGER DOES NOT NAME, in the container it DOES. Both ledger entries use
    // `owner: 'user'`, so no chip built from them can discriminate the OWNER half of the key —
    // measured, deleting `e.owner === chip.owner` left 4/4 green, the exact sibling of the
    // `file` defect fixed one round earlier, on the same lookup line.
    const OWNER_PROBE = 'moderator';
    probeUnnamed('owner', OWNER_PROBE);
    const PLANTED_SOURCE = `
      const submittedBy = { select: { ${NARROW} } };
      const authorChip = { ${NARROW} };
      export const q = {
        user: { select: { ${NARROW} } },
        modChip: { select: { ${NARROW} } },
      };
      const ${EXEMPT.container} = { ${EXEMPT.owner}: { select: { ${NARROW} } } };
    `;
    // 🔴 THAT FIFTH CHIP IS WHAT EXERCISES THE `file` HALF OF THE KEY. The four above resolve
    // to containers no ledger entry names, so the CONTAINER half rejects them and the file
    // half never runs — measured by two review lanes independently: deleting `e.file === rel`
    // from the lookup left all four tests green. The fifth carries a container AND owner that
    // ARE exempted, in a file that is not, so only the file comparison can reject it.
    // 🔴 DERIVED AND PINNED, like the other two probes. This was hardcoded to a path that IS
    // in `SERVICE_FILES`, with no precondition — while the comment below depends on it having
    // no ledger entry. Reproduced: adding one entry for that file makes this probe fail with
    // "five narrow planted chips must ALL be rejected", i.e. exactly the "the guard broke"
    // misreading the sibling preconditions exist to prevent — though only for an entry that also
    // matches a planted chip's container and owner; this precondition keys on `file` alone, so
    // it is wider than the hazard, which is the safe direction. (The claim that both siblings
    // already had one was also wrong when written: only the owner probe did.)
    const plantedFile = SERVICE_FILES.find((f) => f !== EXEMPT.file)!;
    probeUnnamed('file', plantedFile);
    const plantedVerdict = judge(plantedFile, chipsIn(plantedFile, PLANTED_SOURCE));
    expect(
      plantedVerdict.offenders,
      'five narrow planted chips must ALL be rejected by the real verdict path'
    ).toHaveLength(5);

    // 🔴 THE OWNER HALF, which needs the EXEMPT file to reach it: in any other file the FILE
    // comparison rejects first, and in the exempt container the only owner either entry names
    // is `user`. Same container, same file, an owner the ledger does not name — so only
    // `e.owner === chip.owner` can reject it. Measured: dropping that term left 4/4 green,
    // the exact sibling of the `file` defect, on the same line.
    const OWNER_SOURCE = `
      const ${EXEMPT.container} = { ${OWNER_PROBE}: { select: { ${NARROW} } } };
    `;
    const ownerVerdict = judge(EXEMPT.file, chipsIn(EXEMPT.file, OWNER_SOURCE));
    expect(
      ownerVerdict.offenders,
      `a narrow \`${OWNER_PROBE}\` chip inside the exempted container must still be rejected`
    ).toHaveLength(1);

    // 🔴 AND THE CONTAINER HALF — the third term on that same lookup line, and it had the
    // identical hole the other two just had. Its only coverage was the real-corpus ledger
    // equality, which discriminates solely because two live entries happen to share a file AND
    // an owner while differing in container. Measured: simulate retiring the entry this PR's
    // own `why` says should be widened, and dropping `e.container === chip.container` goes
    // 4/4 GREEN. A probe makes the coverage a property of the test rather than of how many
    // rows the ledger happens to hold.
    // 🔴 DERIVED FROM ENTRY 0 BUT CHECKED AGAINST EVERY ENTRY. An earlier version compared
    // only against `EXEMPT.container`'s own name, so a collision with any OTHER ledger row's
    // derived name went undetected — measured, planting the second entry's `…Unlisted` name
    // left this green. Like its sibling above this is message quality, not coverage: a
    // collision would also fail the probe's own `toHaveLength(1)`, just without saying why.
    const UNLISTED = `${EXEMPT.container}Unlisted`;
    probeUnnamed('container', UNLISTED);
    const CONTAINER_SOURCE = `
      const ${UNLISTED} = { ${EXEMPT.owner}: { select: { ${NARROW} } } };
    `;
    const containerVerdict = judge(EXEMPT.file, chipsIn(EXEMPT.file, CONTAINER_SOURCE));
    expect(
      containerVerdict.offenders,
      'a narrow chip in a container the ledger does not name must still be rejected'
    ).toHaveLength(1);

    // ⚠️ This one is weaker than it looks on its own — `plantedFile` has no ledger entries at
    // all, so an empty `matched` is the only possible result regardless of the key. It earns
    // its place only alongside the fifth chip above, which CAN be exempted by a broken key.
    expect(plantedVerdict.matched, 'nothing planted may be exempted').toEqual([]);

    // 🔴 AND A CHIP NESTED INSIDE AN EXEMPTED CONTAINER IS NOT COVERED BY IT. `identify()`
    // walks up to the first variable declaration, so a `user:` three levels deep inside
    // `moderationListingSelect` reports that container — the exempted key. Measured: with
    // `matched` as a Set both chips collapsed into one and this shipped exempt.
    // 🔴 BOTH chips here are NARROW, which is what makes this discriminate. An earlier draft
    // gave the top-level one `deletedAt`, so it was skipped and only ONE chip ever reached
    // `matched` — the control then passed with a Set as happily as with an array, i.e. it did
    // not test the thing it was written for. With both narrow, the exempted key is matched
    // TWICE: an array reports 2, a Set reports 1.
    // ⚠️ HARDCODED DELIBERATELY, where the probes above derive from the ledger. The difference
    // is what each asserts: those assert an OFFENDER COUNT, which stays satisfiable if the
    // row is retired — measured, that is how the file-half coverage went silently green. This
    // one asserts the exemption was CONSUMED TWICE, which structurally requires the row, so
    // retiring it fails loudly here rather than quietly. Deriving it would gain nothing.
    const NESTED_SOURCE = `
      const moderationListingSelect = {
        user: { select: { ${NARROW} } },
        appBlock: {
          select: { publisher: { select: { user: { select: { ${NARROW} } } } } },
        },
      };
    `;
    const nestedFile = 'src/server/services/blocks/app-listing.service.ts';
    const nestedKey = `${nestedFile}::moderationListingSelect::user`;
    const nestedVerdict = judge(nestedFile, chipsIn(nestedFile, NESTED_SOURCE));
    expect(
      nestedVerdict.matched,
      'a nested chip resolving to an exempted key must be COUNTED, so the ledger equality reds'
    ).toEqual([nestedKey, nestedKey]);
    expect(nestedVerdict.offenders).toEqual([]);

    // (c) 🔴 AND THE OWNER RESOLVER NEVER SHRUGS. The regex it replaced returned a sentinel
    // when its 120-character lookbehind failed, and that sentinel was ALSO an exemption key —
    // so `dbRead.user.findMany({ where, select: {…} })`, the commonest way to add a narrow
    // projection, was silently licensed. Every owner below is a real identifier, which is
    // what makes an exemption a decision someone had to write down.
    const chips = SERVICE_FILES.flatMap((rel) => userChips(rel));
    expect(chips.length, 'the corpus must contain user chips to resolve').toBeGreaterThan(0);
    for (const chip of chips) {
      // Every chip in the real corpus resolves to a real identifier pair. A `null` here would
      // not be a licence — it is an offender above — but it would mean the resolver is
      // guessing, and the ledger's entries would stop being readable as decisions.
      expect(chip.owner, `unresolved owner in ${chip.file}`).not.toBeNull();
      expect(chip.container, `unresolved container in ${chip.file}`).not.toBeNull();
      expect(String(chip.owner)).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
  });
});
