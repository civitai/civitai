# Platform constraints that decide App Block design

Measured 2026-09-01 against the `app-requests` clone and the SDK monorepo
`<app-starters>` (`civitai/civitai-app-starters`). **Every figure here decays** —
the SDK ships minor versions weekly and the host moves independently. Re-measure
in phase 0; this file tells you *what to look for*, and the shape of the trap.

🔴 **The load-bearing distinction: the app's PINNED version is what compiles, and
it is not the monorepo.** Measured that day, `app-requests` pinned
`@civitai/blocks-react@0.37.0` while the monorepo was at **0.43.1** — six minor
versions and three methods apart. Reading the monorepo source and designing
against it produces a plan that does not typecheck.

```bash
APP=~/workspace/civit/civitai-app-requests
command grep -n '^\s*[a-z]' "$APP/node_modules/@civitai/blocks-react/dist/hooks/useSharedStorage.d.ts"
```

Read the **installed `.d.ts`**. Not the source, not your memory, not this file.

---

## 1. Shared storage is the whole backend

A first-party board block has no server of its own. `useSharedStorage` is an
app-scoped, append-only, community-votable store, and its surface is the entire
set of things such an app can do.

Surface measured at **0.37.0** (pinned): `list`, `getCount`, `getCounts`,
`append`, `update`, `vote`, `unvote`, `withdraw`.

Added by **0.43.1** (monorepo): `get(key)`, `report(key, reason?)`, and a
`viewerVoted` field on each listed item.

🔴 **`viewerVoted` is a bug fix, not a nicety.** Its own doc-comment says it
fixes the *"double-click to unvote"* bug — a block on a version without it is
guessing the viewer's vote state on load and will get it wrong. When a taste pass
touches voting at all, bump first.

## 2. There is no server-side sort

`list()` is **newest-first** and takes only `prefix`, `limit`, `cursor`. There is
no rank parameter.

So "most-voted first" is a **client-side ranking over the rows you bothered to
load**, and it is honest only to the depth you scanned. The established pattern
is a bounded whole-board scan with an explicit disclosure when it stops at the
cap — reuse it rather than inventing a silent one.

🔴 **Making a scanned order the DEFAULT moves its cost onto cold boot.** That is
a real first-paint regression and it can move the capture recipe's ready anchor.
Measure the live row count in phase 0 and decide with the number in hand.

Client-side **search inherits the same horizon**, and the failure is worse: a
filter that silently misses row 201 reads as "no such request exists".

## 3. Keys are host-minted and opaque

`append(value)` returns a host-chosen key; the block cannot supply or prefix one.

🔴 **Therefore `list({ prefix })` cannot scope child records to a parent.** Any
threaded structure — comments, replies, attachments — has to be ordinary entries
tagged inside the app-owned `data` blob and filtered client-side, which means:

- children share the one paginated stream with parents, halving effective board
  capacity;
- a per-parent child *count* is only correct within the scanned window.

This is the constraint that has most often turned a one-line ask into a platform
work item. Surface it as a fork before building.

## 4. `data` is UNMODERATED — user text must not live there

Each entry is `{ title, body?, data? }`. The content-safety belt runs on
`title`/`body` **only**; `data` is opaque app structure.

🔴 So the denormalisation trick in §5 has a hard edge: a *username* is arguably
user-controlled text. Keep anything a person typed in `title`/`body`, and put
only structural values in `data`.

## 5. There is no user lookup

The listed item carries `authorUserId` as a bare **number**. Measured that day,
no message type resolves a user, and the only identity scope is
`user:read:self` — which reads *the viewer*, not the author of a row.

Two workarounds, both with teeth:

- **Denormalise at write time** — capture the poster's handle when they post.
  🔴 **Cannot retrofit.** Every row already in production has no handle, so the
  card needs a legacy fallback and the board will look mixed for a long time.
- **Derive from the id** — a deterministic avatar/handle. Uniform, but it is
  never the person's real identity, and it cannot link to a profile.

If neither is acceptable, the honest answer is that identity is **platform work**,
not app work.

## 6. Owner moderation does not exist client-side

Measured that day there is no owner-moderation capability:

- `update` and `withdraw` are **author-scoped** — they reject `FORBIDDEN` for
  anyone but the row's author. The app owner is not special.
- `report(key, reason?)` files for **platform** moderator review and its own doc
  states *filing a report does not hide the row*.

🔴 So "the developer can remove things" is only achievable as a **client-side
soft-hide**: an owner-authored ledger entry that every client honours. The row
still exists server-side. That is a legitimate design — the store is unreachable
except through the app — but it must be *named* as suppression rather than
deletion, in the code and in the UI copy, or the next maintainer will believe the
data is gone.

## 7. Anonymous viewers read but cannot write

Reads (`list`, `getCount(s)`) work signed-out; every mutation hard-rejects
**against the real host**. Any UI that offers a mutation to a signed-out viewer
is offering an error.

🔴 **"Test that path explicitly — the mock host supports it" was WRONG, and it
sent an agent looking for a test that cannot exist.** Re-measured 2026-09-02:
`createMockHost` computes `const mockUserId = viewer?.id ?? 0`, and **no
`SHARED_*` handler checks for a viewer at all** — `SHARED_APPEND` validates
`failNext` and `value.title` and then writes `authorUserId: mockUserId`. So with
`viewer: null` an anonymous append **succeeds**, attributed to user 0. The mock
is *more permissive* than production on exactly the axis you would want to test.

**What you can actually assert against the mock** is that no mutation
*affordance* is offered signed-out — a UI claim, not a transport one. The
rejection itself is only observable against the real host. Say which of the two
a test covers; they are not interchangeable, and the weaker one reads like the
stronger one in a test name.

## 7b. `failNext` covers more than its doc-comment says

`shared.failNext` is the failure-injection knob, and it is the control that
proves your rejected-mutation tests can go red at all — set it and watch the
test fail, or you have not validated the instrument.

Measured 2026-09-02, it is consumed by **all seven** `SHARED_*` handlers —
`APPEND`, `GET`, `REPORT`, `UPDATE`, `VOTE`, `UNVOTE`, `WITHDRAW` — not the four
its own comment lists. Useful, because it means the read and report paths are
injectable too; but it also means a doc-comment here is not the authority.
`awk`-scan the handler cases before believing any list, this one included.

## 7c. Pin the SDK PAIR, not one package

`@civitai/blocks-react` and `@civitai/app-sdk` move together, and the peer range
is wide enough to resolve a **mismatched** pair without complaining. The
canonical pairing is whatever `<app-starters>/starters/civitai-block-starter/package.json`
declares — measured 2026-09-02 as `@civitai/app-sdk ^0.35.0` with
`@civitai/blocks-react ^0.43.1`. Take it from there, never from the peer range's
floor. The other starters resolve `workspace:^` and tell you nothing.

🔴 **That snapshot decayed in two days — re-read it, do not quote this file.**
Measured 2026-09-04 at `app-starters` `origin/main`, the starter declares
`@civitai/app-sdk ^0.37.0` with `@civitai/blocks-react ^0.46.0`. **`app-sdk` had
moved a full minor past the figure above**, which is the half nobody re-checks
because `blocks-react` is the package a pass usually cares about. Both halves move.

🔴 **And the peer range is not always wide enough to hide a mismatch — sometimes
it is narrow enough to make one ILLEGAL, which is worse if you bump only one
package.** `blocks-react@0.46.0` peers `@civitai/app-sdk >=0.29.0 <1.0.0`, and
`gen-matrix` pinned `^0.28.0` — *below the floor*. So on that app, bumping
`blocks-react` alone does not merely resolve a mismatched pair, it resolves one the
peer range forbids. **Read the target's `peerDependencies` before bumping either
package**, and bump the design-system three (`theme`, `components`,
`components-react`) to exactly what the new pair exact-pins, or the tree installs
two copies:

```bash
npm view @civitai/blocks-react@0.46.0 dependencies peerDependencies --json
```

### 7d. 🔴 A pnpm STORE version count is NOT a deduplication check

The npm-shaped probe for nested copies does not transfer, and both of its halves
fail on pnpm — measured 2026-09-04 bumping `gen-matrix`:

- `find node_modules -path '*node_modules/*node_modules/@civitai/*'` matches
  **every** package by construction, because pnpm stores each one at
  `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>`. It reports duplicates that
  do not exist.
- Counting distinct versions under `.pnpm` looks like the fix and is **also
  wrong**: the store RETAINS the old entry after an upgrade, so immediately after a
  successful bump it reports *both* versions of all five packages. Before the bump
  the same command reported one each — so it agrees with you exactly when nothing
  has changed, which is when you least need it.

**Check what is LINKED, not what is stored** — `readlink -f` is the arbiter, and
cross-check it against the resolved package's own `version` field so one bad read
cannot pass:

```bash
for p in app-sdk blocks-react components components-react theme; do
  printf '%-18s %s\n' "$p" "$(readlink -f node_modules/@civitai/$p)"
done
```

The resolved `blocks-react` path also carries its peer resolution in the directory
name (`…blocks-react@0.46.0_@civitai+app-sdk@0.37.0_react@19.2.7`), which settles
§7c's pairing question in the same read.

## 8. The block is an iframe with a declared height contract

The manifest fixes `minHeight`/`maxHeight`/`resizable`. Content that grows —
expanding rows, animating panels, a newly-revealed thread — must tell the host,
or it clips. The symptom looks like a CSS overflow bug and is not.

## 9. Everything ships through moderator review

`civitai app submit` queues a version for review; media attached to a live
listing opens a **shadow revision** that leaves the live listing untouched until
approval. Batch a taste pass into one submission — a per-phase release multiplies
review latency for no benefit.

🔴 **Staging is not submitting, and the CLI says both things.** `attach.sh`
reports *"staged on a revision — pending moderator review"* while
`rm-screenshot` correctly says *"not submitted for review yet"*. The second is
right: the revision sits open until an explicit **`civitai app listing
submit-revision`**. Trust the first message and the whole revision waits
forever, looking finished. Stage everything — adds, removals, captions — then
submit once.

🔴 **Screenshot ids are re-keyed TWICE, and the second time is undocumented.**
The known one is at attach: `add-screenshot` returns an id minted on the clone,
not an echo. Measured 2026-09-02, **approval re-keys them AGAIN** — a revision
holding `apls_…NFVKHS` / `…AJ06H2` went live as `apls_…TJFJA` / `…TJFJB`. So an
id captured from the revision is **stale the moment a moderator approves**, and
any later `reorder` (which requires ALL current ids), caption edit or removal
built on it addresses rows that no longer exist. **Re-read the listing after
approval; never carry an id across it.**

**Two CLI wrinkles worth knowing:** `add-screenshot` requires `-y` while
`rm-screenshot` *rejects* it, and `appListings.persistAssetImage` times out
often enough to fail **three times consecutively** — measured with a 303 KiB PNG
twice and a 96 KiB JPEG once, identical failure, so size is not the variable —
then succeed on the fourth. 🔴 A client timeout is not evidence the server did
nothing: **re-read the listing between attempts** rather than retrying blind, or
three "failed" uploads become three screenshots.

✅ **FIXED for `attach-offsite.py` (2026-09-04) — the "no retry or backoff" this
section used to state is no longer true of that script.** It now carries an
explicit `HTTP_TIMEOUT` (`urlopen`'s default is `None`, i.e. **block forever** —
a worse failure than the one the retry is for, because a hang prints nothing),
catches `URLError` as well as `HTTPError` (a socket reset used to escape as an
unhandled traceback), and retries transients with a widening backoff bounded at
four attempts — enough to cover the measured 3-fail/4th-succeeds case.

🔴 **The retry is scoped by a LEDGER, and the scoping is the whole safety
argument.** Only calls that cannot change the LISTING are re-sent: the two reads,
plus `ingestAssetFromDataUri` and `persistAssetImage` — which merely MINT an
image and return its id, because attachment happens later and separately in
`setIcon`/`setCover`. So a re-send can at worst orphan an image row nothing
references; it cannot produce a second attached asset. **`setIcon`, `setCover`
and `submitListingRevision` are deliberately NOT retryable** and must stay that
way. `tests/run-tests-app-capture.sh` gate **O1** asserts that ledger WHOLE, so
it fails when the set grows as well as when it shrinks.

✅ **`attach.sh` (the ONSITE path) is now guarded too (2026-09-04) — by a
DIFFERENT mechanism, and the difference is the interesting part.** It does **not**
retry, and must not: `add-screenshot` genuinely ATTACHES, so a re-send adds a
second screenshot — unlike `persistAssetImage`, which only mints an image. The
hazard there was never a blind retry in the script; it was that a failure
`exit 5`d **straight past the re-read**. So the one thing that distinguishes
"the server did nothing" from "the server did it and the client lost the reply"
was skipped exactly when it was needed, and the natural response to a bare
`attach FAILED` is to run the same command again.

Now the failure path stops, re-reads the listing, and says plainly: *do not
re-run this blind, count the assets below first.* **The operator decides from the
COUNT, never from the exit code.** Gates **D6b** (failure path re-reads and warns)
and **D6c** (its positive control: the success path exits 0 and does NOT print
the warning, so D6b is not passing on boilerplate) pin both directions.

## 10. The capture recipe is coupled and ungated

`.claude/skills/app-capture/scripts/recipes/` holds one recipe per onsite app,
naming its ready anchor, its clickable ledger and its states. A redesign
invalidates all three, and **no gate in either repo can see that**. Treat the
recipe as part of the app's diff.

🔴 **And the obvious way to check a recipe still resolves — grep the testid —
CANNOT SEE A COMPOSED ONE.** Measured 2026-09-02: `search-input`, which a
shipped recipe types into, appears **nowhere** in the app's source, in any
version, because `SearchField` emits `` `${testId}-input` `` from a defaulted
prop. So the check returns a confident **zero** whether the selector works or
has just been deleted — the two cases are indistinguishable, which is the worst
possible property for a coupling nothing else guards. It briefly read as a
subagent having broken a recipe while claiming it hadn't.

**Grep the SUFFIX, or the prop that builds it, and confirm the prefix's
default** — or settle it the only way that cannot lie, by running the recipe
against the live app. A recipe is verified by resolving, never by grepping.

🔴 **But the recipe FILE and the RE-SHOOT are not the same step and cannot ship
together.** The file can be rewritten from the new testids in the pass's own PR;
the re-shoot cannot happen until the new version is **live**, which means through
moderator review. Phase 7 is therefore always split: file now, shoot after
approval. Treating it as one step produces a pass that reports itself finished
while its store images still show the old app.

## 11. `--aspect-ratio` is not honoured, and the dry-run confirms the wrong thing

Measured 2026-09-01 generating an `app-requests` hero: `civitai generate
--aspect-ratio 21:9` produced four images at **1216×832** — ≈1.46:1, nowhere near
the 2.33:1 requested.

🔴 **Two separate things make this hard to catch.** The `--dry-run` output prints
`Aspect ratio: 21:9` straight back, which reads as acceptance and is only an echo
of your own argument. And the flag's help says *"width/height derive from it"*,
which is false client-side: `--print-input` shows the graph carries
`"aspectRatio": "21:9"` as an opaque **string**, with no width/height anywhere —
so the CLI is faithful and the **server** chose the dimensions.

What was NOT established: whether the server clamps unknown buckets to a nearest
supported one, ignores them entirely, or rejects 21:9 for that ecosystem
specifically. Distinguishing those costs another generation and nobody has paid
for it.

**So: never trust the requested ratio for a hero.** Measure the produced file
(`file <img>` prints the dimensions), and expect to crop to the slot geometry
rather than to generate into it. Budget the hero as *generate wide-ish, then
crop*, and record the realized dimensions in `taste.json` next to the seed.

Unrelated but same command, worth knowing: the realized charge came in **under**
the estimate (29 Buzz against 4 × 8 estimated). The estimate is not binding in
either direction.

## 11b. The BLOCK'S OWN LAYOUT doesn't honour an aspect either

§11 leaves you with the instinct *"fine — compose the art to the slot"*. That is
**not sufficient**, and the second half of the trap is downstream of the
generator entirely.

Measured 2026-09-02 on this app's hero: a `HERO_ASPECT = '3 / 1'` constant was
applied as CSS `aspect-ratio` to an `<img>` that already carried explicit
`width:100%; height:100%` — so it was **inert**. It changed nothing, while
reading in the source as a guarantee, and the file's own comment (written by the
same session that shipped the art) asserted *"keep 3:1, the band reserves that."*
The band reserves nothing. The band's WIDTH is the host page's, so its aspect
moves with the viewport: a 3:1 asset rendered into a ~6:1 band at one width and
went TALLER than 3:1 at 380px, flipping the crop axis.

Two consequences, and the second is the general one:

- **A hero's legibility must be STRUCTURAL, not compositional.** Art positioned
  to dodge an overlaid control at one width collides with it at another. A scrim
  and an opaque plate under the control hold at every width; `object-position`
  cannot — with the band wider than the source there is no horizontal slack at
  all, so it fixes the crop axis and nothing else. Verify at several widths,
  including a narrow one, or you have verified one viewport.
- 🔴 **A declared constant is not a constraint until something READS it.** This
  is the DTO-field trap in CSS: `aspect-ratio` loses to explicit width+height,
  so the declaration lost silently to a rule two lines away. Before trusting any
  such constant, find its consumer and confirm it can win — and prefer a name
  that says what it IS (`HERO_SOURCE_ASPECT_RATIO`, a fact about the file) over
  one that sounds like an instruction the layout obeys.

## 12. 🔴 `civitai app pull` gives you the DEPLOY MIRROR, not the dev source

Measured 2026-09-03 doing phase 0 for `gen-matrix`, `panorama-360` and
`playable-collections`. This is the single most expensive thing phase 0 can get
wrong, because the wrong repo looks completely right: correct slug, correct
manifest `version`, a clean `main`, and a HEAD commit that names the live
release.

`civitai app pull` clones from **`forgejo.civitai.com/civitai-apps/<slug>`**. That
repo is the *published-artifact* mirror. Its HEAD is an auto-generated
`Approved publish request pubreq_… — <app> v<ver>` snapshot, it has **only**
`main`, and — the discriminator — **the `Source commit` that `civitai app status`
reports does not exist in it at all**:

```
git -C <clone> cat-file -t 7d20415bff8a0c852d52727c00e5fa3b6321a6c4
  fatal: git cat-file: could not get object info
```

Development happens on **GitHub**, which is where every branch, PR and review
lives. So a pass based on a `civitai app pull` clone has no history to branch
from, no PR target, and silently drops whatever landed on the dev repo after the
last publish.

**Phase 0 question 1 is what catches this** — but only if you run it as written.
`cat-file -t <live sha>` against the clone is the whole check; the manifest
version comparison *passes* on the mirror and tells you nothing.

### 12a. The dev repo's name is NOT derivable from the slug

Three different shapes across seven apps, so resolve it, never construct it:

| slug | dev repo |
|---|---|
| `app-requests`, `sensei`, `custom-generators`, `gen-matrix`, `model-benchmarking`, `playable-collections` | `ZacxDev/civitai-app-<slug>` |
| `panorama-360` | **`civitai/app-panorama-360`** — different owner, no `civitai-app-` prefix, and **public** |

🔴 `civitai/app-panorama-360` being **public** puts it under the same rule as
`civitai/civitai`: no infra internals in its PRs, branches or comments.

The manifest's own `repository` field is the authority — read it first:

```bash
git -C <clone> show origin/main:block.manifest.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["repository"])'
```

`gh search repos <slug>` is the fallback when there is no clone yet.

### 12b. The pulled clone embeds an access token in `.git/config`

`civitai app pull` warns about this in its own output, and the warning scrolls
past. The remote is `https://<token>@forgejo.civitai.com/…`. If you pulled a
mirror by mistake, **delete the directory** rather than repointing it — that
disposes of the token with it.

### 12c. The CLI signature in phase 0 was wrong

`civitai app pull <slug> <dir>` is rejected: *"accepts at most 1 arg (the target
DIRECTORY) … the app goes in `--app`"*. The real form is
`civitai app pull <dir> --app <slug>`. Corrected in `SKILL.md`, recorded here
because the error text is clear and the failure is loud — unlike everything else
in this section.

## 13. `civitai app status <slug>` reports the newest SUBMISSION, not what is live

Measured 2026-09-03 on `playable-collections`: the per-app lookup returned

```
Version: 0.2.5   Status: withdrawn   Deploy state: -
Not live yet — playable-collections.civit.ai only serves after the app is approved…
```

while the app *is* live at 0.2.5. There are **two** submissions of 0.2.5 — an
approved one (`pubreq_01M10YCSM62259KZS10HTBJM60`, live) and a later withdrawn
one (`pubreq_01M121GRZRMHFFAJZ5WWV0VCJJ`). The lookup surfaces the later row, so
the reassuring-looking *"Not live yet"* sentence is false, and a phase 0 that
believes it concludes the app is unpublished.

🔴 **Two submissions can share a version string**, so the version alone does not
identify a deploy — reconcile on the `pubreq_` id. `civitai app status` with no
argument lists per-submission rows including the approved one, but it is capped
at the newest 100 and says so, i.e. it is a sample. When the two disagree,
**the deploy mirror's HEAD names the pubreq that is actually serving**.

## 14. Manifest facts phase 0 keeps re-deriving

- The file is **`block.manifest.json`**, not `civitai-app.json`.
- The iframe height contract of §8 lives under **`iframe.{minHeight,maxHeight,resizable,sandbox}`** — not at the top level. A top-level read returns `None` for all of them and reads as "unconstrained".
- `repository` is the dev-source authority (§12a); `page.buzzBudgetPerGen` caps a spend-path app's per-generation budget.

## 15. 🔴 Full-bleed is the RULE on this corpus, not the exception — "two of two" was already three of three

Rank 8 of the app-taste rollout was scoped on the belief that **two** apps could
not use the frame-relative crop anchor. Measured 2026-09-04 during
`custom-generators`' phase 0, it is **three of three onsite apps that have been
capture-probed**:

| app | probe | can it use the anchored form? |
|---|---|---|
| sensei | `leftInset=0, rightGap=-1` | no — the app frame IS the viewport |
| model-benchmarking | content 100% of frame width after its `maxWidth` was removed | no |
| custom-generators | content fills **53.4% x 100.0%** of the usable band | ⚠️ **CORRECTED — see below.** It refuses `full_frame`, but its FRAME is not the viewport |

`capture.sh … --evidence` exits **5** on the last of these with
`REFUSE[full_frame]`, and the refusal's own cause (b) is the right reading: the
content genuinely fills the band, **no band setting can fix it, and the gate is
right to refuse**. Only the first of that recipe's four states is captured before
it stops.

🔴 **Two things follow, and the second is the planning one.**

- A phase-0 baseline for a full-bleed app is **partial by construction** — you
  get evidence JSON (DOM, console, network, a11y, testids) for the states that
  ran, and no shippable framing for any of them. That is still worth running:
  every phase-0 finding for `custom-generators` came out of the one state that
  did capture. Do not read `rc=5` as "the capture failed".
- **A migration whose candidate set is empty is not a migration.** Teaching the
  framing gate more arithmetic (rank 8) cannot help an app whose content is 100%
  of an axis, and that is now every probed app rather than a minority. Settle the
  shoot route first (rank 5) — `emulate` a viewport on a bridge-owned tab, shoot
  `--no-frame`, crop by hand — and only then ask whether any app is left that
  wants the anchored form.

🔴 **CORRECTION, same day, and it retracts the strongest claim above.** The table's
third column conflated **two different measurements**, and only the first was taken:

- **Refusing `full_frame`** is a statement about the app's CONTENT filling the
  detection band. All three do this.
- **Being unable to use the frame anchor** is a statement about the app's IFRAME
  filling the VIEWPORT. That is a different quantity, read from a different
  probe.

`APPFRAME_RECT` is `(top, bottomGap, rightGap, vw, vh, left)`, and the two apps
disagree on exactly the fields that matter:

| app | probe | leftInset | rightGap | reading |
|---|---|---|---|---|
| sensei | `104,64,-1,849,1255,0` | **0** | **-1** | frame IS the viewport — no horizontal slack |
| custom-generators | `104,64,803,3431,1285,803` | **803** | **803** | **1825 px frame in a 3431 px viewport — 803 px of page on each side** |

So custom-generators is **not** the same shape as sensei, and the anchored form is
not ruled out for it — the anchored declared rect is in fact the *remedy* the
`full_frame` refusal itself recommends, because the declared-rect whole-frame
check is an **AND across axes** while the detection gate is an **OR**. An app that
is 100% on ONE axis may legitimately declare a rect; custom-generators is
53.4% × 100.0%, i.e. full on one axis only.

⚠️ **What this does NOT establish.** One measurement at one viewport cannot tell a
**max-width** app from a full-bleed one — 803 px of slack is merely inconsistent
with full-bleed at *that* width. The discriminator is step 7 of the conversion
procedure (re-tile, re-run: an `exit 14 frame_of_record` means the frame's own
width moved, i.e. full-bleed after all). Until that second measurement exists,
the honest claim is "custom-generators has horizontal slack at 3431 px", not
"the conversion will work".

🔴 **Consequence for the rollout's rank 8** (`teach gate P18 the xFrom/wFrom
arithmetic): its candidate set was recorded as EMPTY on the strength of the
retracted claim. It is **not** empty — custom-generators is a live candidate, and
converting it would produce the first shipped recipe using the horizontal anchor.
Re-scope it on the measurement, not on this correction alone.

🔴 **SETTLED 2026-09-04 BY A SECOND MEASUREMENT — and it supersedes BOTH statements
above.** The original claim ("cannot use the anchored form") was right about
custom-generators for the wrong reason; the retraction ("has horizontal slack, so the
anchor is not ruled out") was right at one width and said so. The re-tile it named as
the discriminator has now happened, by accident — a live run refused
`frame_of_record` naming a 1710 px frame against the recorded 1825.

| window | leftInset | rightGap | frameW | content column |
|---|---|---|---|---|
| 3431 px | 803 | 803 | **1825** | 1221..2192 (971 px) |
| 1709 px | **0** | **-1** | 1710 | 360..1331 (**971 px**) |

**custom-generators is a max-width container capped near 1825, and the cap sits ABOVE
the widths actually in use.** The content column is 971 px at BOTH — fixed, not fluid —
but the FRAME stops being centred once the window drops below the cap, at which point
`leftInset` is 0 and `rightGap` is −1: sensei's exact signature. One session here saw
1709, 3431, 1135 and 849 px windows, so three of those four are below the cap.

So the horizontal anchor is **not wrong for this app, it is useless for it**: both
insets go to ~0 at the common widths, it buys nothing over the absolute form, and
`frame_of_record` would refuse on nearly every re-tile. It converted to the ordinary
**`yFrom`-only** declared rect instead (`925ff2047`), which is what every other
declared recipe uses.

🔴 **The rollout's rank 8 therefore still has NO candidate, and the reason is now
measured rather than asserted twice.** A candidate needs a frame whose width is stable
across the operator's real window sizes — which means a max-width cap BELOW them, not
above. Test that with two captures at different widths before converting anything;
one width cannot tell the two apart, which is exactly how this went round twice.

⚠ **Scope this honestly: three apps is the PROBED population, not the corpus.**
`gen-matrix`, `playable-collections` and `panorama-360` have not been
capture-probed, so the claim is "every app measured so far", not "every app".

🔴 **`gen-matrix` IS NOW PROBED — and it does not refuse.** Measured 2026-09-04,
`capture.sh … --evidence` exits **6** with `REFUSE[too_few_states]`, never reaching
the framing gate. That is the recipe's own documented, must-stay-red ceiling (it has
exactly one state that does not spend Buzz), **not** a `full_frame` refusal. So the
probed population is now four, and the fourth is silent on the full-bleed question
rather than agreeing with it. Do not fold it into the "three of three" tally.

## 16. `app-sdk` ≥ 0.37.0 can read the host's theme BEFORE the handshake

New in `@civitai/app-sdk@0.37.0`, and absent at `0.28.0` — measured 2026-09-04 by
the presence of `dist/blocks/initFragment.d.ts` in one and not the other.

`parseBlockInitFragment(hash)` returns `{ theme?, renderMode?, blockInstanceId? }`
decoded from the iframe URL's **fragment**, readable *synchronously at document
parse time* — before any `postMessage`. The wire format is
`#civitai-block=v1&theme=dark&renderMode=iframe&blockInstanceId=bi_abc`.

🔴 **Why this matters to a taste pass specifically.** The pre-`ready` theme problem
is otherwise unsolvable: `useBlockContext().theme` is a *sentinel* before `ready`
(the SDK's pre-init snapshot hardcodes `theme: 'light'`), so a block that branches
on it paints every viewer light until `BLOCK_INIT` lands — and against a dark boot
skeleton that is a dark → light → dark flash **introduced** by opting into
`bootSkeleton: true`. The established workaround is an OS `prefers-color-scheme`
guess, which is the *machine's* theme and can simply differ from the host's. The
fragment is the host's actual theme, so it is strictly better than the guess.

**Three properties that make it safe to adopt**, from its own contract: decoding
never throws and never returns a partially-trusted value; an unknown version marker
decodes to `{}`, so a future host degrades to "no fast path" rather than garbage;
and `BLOCK_INIT` remains authoritative and overwrites it. The token, viewer,
settings and context are **never** in the URL — only those three non-secret fields.

So on an app pinned below 0.37.0, "we cannot read the theme before ready" is true;
on one pinned at or above it, that sentence is stale. Check the pin before
repeating it — two comments in `gen-matrix` asserted it and both went false the
moment the pin moved.

## 17. 🔴 A testid enumeration by literal grep MISSES the conditional ones

Same family as §10's composed-testid trap, and it bites the *inventory* step rather
than the recipe-check step. Measured 2026-09-04 on `gen-matrix`: grepping
`data-testid=["']` over `src/` returned **49 sites / 48 unique ids**, and
`gm-generate` — the id that recipe's own `ready` anchor waits on — was **not among
them**. It is written `data-testid={anon ? 'gm-signin' : 'gm-generate'}`, so the
pattern's required quote-after-`=` never matches.

The confident zero is the danger: a literal grep says the recipe's ready anchor does
not exist in the source, which reads as "the recipe is broken" when the app is fine.

**Enumerate both shapes and diff the counts** — an expression site is a testid you
have not read yet:

```bash
command grep -rho 'data-testid=["'"'"']' src --include=*.tsx | wc -l   # literal
command grep -rho 'data-testid={' src --include=*.tsx | wc -l          # expression
```

🔴 **And a conditional testid is a live capture hazard, not just a grep one.** That
ternary means the ready anchor **only exists for a signed-in viewer** — signed out,
the same node renders `gm-signin`. A capture run against a signed-out browser
therefore waits the full `timeoutMs` (45 s here) for a control that structurally
cannot appear, and times out naming the anchor, which reads as a slow or broken app.
The evidence JSON settles it in one field: `testids.ids` containing `gm-generate`
proves the run was signed in.

## 18. 🔴 You can SEE a block render without touching the operator's screen

The rule that every real defect in this arc was found by LOOKING at the running
app has had a standing cost: `app-capture` drives the operator's browser, which
activates a tab and focuses its window. That cost is avoidable during a pass.

Every first-party app has a `dev:harness` script — vite plus the mock host — so
it can be rendered and screenshotted **headlessly**:

```bash
APP=~/workspace/civit/gen-matrix-worktree
(cd "$APP" && nohup nix-shell -p pnpm nodejs_22 --run 'pnpm dev:harness' >/tmp/h.log 2>&1 &)
nix-shell -p chromium --run "chromium --headless --no-sandbox --disable-gpu \
  --hide-scrollbars --virtual-time-budget=8000 --window-size=1100,1400 \
  --screenshot=/tmp/harness.png http://localhost:5187/"
```

Four things that make it work, each of which silently ruins the shot if missed:

- **The port is per-app and pinned by `.env.development`**, which sets
  `VITE_BLOCK_ALLOWED_PARENT_ORIGINS` to the dev-server origin. The harness fires
  `BLOCK_INIT` from `window.location.origin`, so a mismatched port means the
  transport drops the message and the app never boots — you get the skeleton.
  Read the port from the app's own `dev:harness` script, never assume 5187.
- **`--virtual-time-budget` is what lets the app finish booting.** Without it the
  screenshot lands mid-skeleton and looks like a broken app.
- **The mock host is not production** (§7) — it is more permissive, and it emits
  `signedIn` ahead of the real host. So this shows you LAYOUT, never a transport
  or authz claim.
- 🔴 **Kill the server by RESOLVED PID with its cwd confirmed**, never a `-f`
  pattern: `ss -lptn 'sport = :<port>'` for the pid, then check
  `readlink -f /proc/<pid>/cwd` is YOUR worktree before `kill`. Sibling agents run
  vite too.

Use it for the taste delta and for any "does this actually render" question. The
operator's browser is still required for anything about the LIVE app — a served
bundle, a real viewer, a real spend.

## 18b. 🔴 `civitai app listing status` is NOT a pure read — the public route is

Its own help says so, and it is easy to miss: **on a LIVE (approved) listing it
opens an in-progress shadow revision draft** and reports THAT draft's media —
"with or without `--json`". It is idempotent (reuses an existing draft) and
submits nothing, but a script that polls it keeps a revision draft open on a
live listing. That holds for offsite apps too.

**For a read — including "does this app have screenshots?" — use the public
route instead**, which mutates nothing:

```bash
curl -sS -H 'User-Agent: Go-http-client/2.0' https://civitai.com/api/v1/apps/$SLUG \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["screenshots"]))'
```

🔴 **Use the PER-APP route, not the list route.** `/api/v1/apps` (the list)
carries **no `screenshots` key at all**, so a zero read from it is a missing
field rather than an empty set — the two are indistinguishable and only one is
true. The per-app route has the key. Measured 2026-09-04: `comfy` 0, `radio` 0,
against a positive control of `gen-matrix` 1, `model-benchmarking` 3,
`custom-generators` 4 on the same route, which is what makes those zeros
quotable. (The list route also caps `limit` at 50 and 400s above it, with a
clear error.)

Cloudflare 1010-bans the default Python-urllib UA on civitai.com — pass an
ordinary client string, as `attach-offsite.py` does.

## 18c. 🔴 THE COHORT GATE: it has MOVED, and the row that used to say "publish is author-only" is now WRONG

🔴 **RETRACTED FOR `publishGenerationOutputs`, 2026-09-16 — re-read at `civitai`
`origin/release`.** The table below was measured 2026-09-05 at `d839654ce6` and its
first row has since gone false: **`publishGenerationOutputs` is no longer gated by
the app-developer cohort.** There is exactly **one** `await
assertViewerIsAppDeveloper(...)` call site left in `blocks.router.ts`, and it is the
block-**settings** persist proc (which additionally requires `claims.ctx.modelId`).
Every other occurrence of the identifier in that file is a comment or the definition
— so the discriminator is `command grep -n '^\s*await assertViewerIsAppDeveloper'`,
never a bare grep for the name.

`publishGenerationOutputs`'s actual gates, read in order at that ref: the
`ai:write:budgeted` scope, an authenticated viewer, `assertAppBlocksEnabledForTokenUser`,
an image-weighted publish rate bucket, a durable (user, app, workflow) ownership
proof, and the orchestrator's own app-tag. The change is recorded in the platform's
own words in the sibling `getMyBuzz` docblock: *"Removing that gate (so the
non-author cohort can use apps at all) would have left this proc readable by ANY
valid block token"* — i.e. the cohort gate was deliberately withdrawn from the
runtime procs and replaced by **scope grants**.

🔴 **AND IT IS NOT ONE ROW — IT IS EVERY "YES" IN THE OLD TABLE.** The first draft of
this correction said *"the rest of this section stands"*, which was itself false and
was caught only by counting the call sites instead of asserting it. The cohort gate
has been withdrawn from the **runtime** procs wholesale and replaced by scope grants:

- `blocks.router.ts` — **one** call site, in `updateUserSettings` (block settings,
  which also needs `claims.ctx.modelId`). So `pollWorkflow` / `listMyWorkflows` /
  `cancelWorkflow` are **not** cohort-gated either.
- `apps.router.ts` — **one** call site, and it sits **inside the
  `claims.reviewRunForReal === true` branch** of the storage-context resolver: it
  gates a MODERATOR running an *unapproved* app for real during review, nothing
  else. The ordinary per-user KV ops (`get`/`set`/`delete`/`list`) gate on the
  DECLARED SCOPES `apps:storage:read` / `apps:storage:write`. (Cross-check that
  costs nothing: `custom-generators` has shipped per-user KV drafts to its ordinary
  audience for months — had the KV been author-only, drafts would have been broken
  for everyone but the author.)
- Shared storage is unchanged and still deliberately open — see the row below.

🔴 **Why this matters enough to write down: the stale row kills a whole class of
design.** "Publish is author-only" means an app's audience cannot keep what they
generate, which removes the only durable end-state a first-party block can own
without `posts:write:self`. `custom-generators`' 0.7.0 taste pass was scoped on the
corrected reading and ships its terminal on `ai:write:budgeted` alone — a
submission that needs no new scope grant. Had the row been taken on trust, the pass
would have concluded the app could not clear its bar.

⚠️ **What DOES still stand**: the shared-storage row, the reasoning trap below, and
the impersonation asymmetry. But re-read that last one with the correction in hand —
publish being author-only was one half of the asymmetry it describes, so the
asymmetry is now *narrower* than it was written (the remaining half, that `getImages`
resolves images **the app** published rather than images **this viewer** published,
is untouched and is the part that actually produces the impersonation surface).

🔴 **General lesson, and it is the reusable part: a gate's LOCATION is as perishable
as its existence, and "which procs does it cover" decays faster than "does it
exist".** This file already told you to check the server rather than the SDK, and
that was right — the server then moved anyway. **Count the call sites; do not grep
the name.** Every other occurrence in these files is a comment or the definition, so
a bare `grep assertViewerIsAppDeveloper` returns 7 hits in `blocks.router.ts` and
reads as "heavily gated" when the answer is one:

```bash
CIVITAI=~/workspace/civit/civitai
git -C "$CIVITAI" show origin/release:src/server/routers/blocks.router.ts \
  | command grep -nE '^\s*await assertViewerIsAppDeveloper'
```

| surface | gated by the app-developer cohort? | authority (read at `origin/release`, 2026-09-16) |
|---|---|---|
| `blocks.publishGenerationOutputs` | ⚠️ **NO** — was YES at `d839654ce6` | no `assertViewerIsAppDeveloper` call on this proc; gates are `ai:write:budgeted` + auth + kill-switch + rate bucket + (user, app, workflow) ownership + orchestrator app-tag |
| `blocks.pollWorkflow` / `listMyWorkflows` / `cancelWorkflow` | ⚠️ **NO** — was YES | same file; the sole call site is `updateUserSettings` |
| `blocks.updateUserSettings` (block settings) | ✅ **YES** — the only one left | `<civitai>/src/server/routers/blocks.router.ts`, sole call site; also requires `claims.ctx.modelId` |
| per-user KV (`apps.router` `get`/`set`/`delete`/`list`) | ⚠️ **NO** — gated on DECLARED SCOPES | `<civitai>/src/server/routers/apps.router.ts`; its one cohort call is inside the `reviewRunForReal` branch only |
| **shared storage `append` / vote / report** | ✅ **NO, ON PURPOSE** | `<civitai>/src/server/routers/apps-shared.router.ts` |

`resolveSharedContext`'s own comment states the design: it *"does NOT reuse
resolveStorageContext / `assertViewerIsAppDeveloper` (that gates to app-authors only;
**copying it would FORBID all general users**)"*. Its per-op asserts are a valid block
token → approved AppBlock, the shared read/write scope, a fail-closed Flipt kill-switch,
and for writes an authenticated subject plus a **min-trust gate**. Anon may READ; anon
never writes or votes.

### 🔴 The reasoning trap, and it cost a full audit round

`usePublishGenerationOutputs`'s doc-comment enumerates publish's rejection causes as
*"anon viewer / missing scope / not-owned workflow / rate-limit / upload or scan
failure"* — and **omits the cohort gate entirely**. `assertViewerIsAppDeveloper` appears
in the vendored SDK `.d.ts` exactly once, on a DIFFERENT call (inline `customComfy`
submission).

So a careful adversarial auditor searched the SDK, found the identifier only on the
unrelated call, and filed a 🔴 saying the app's on-screen warning — *"if your account
isn't one of those, the request is declined and nothing is published"* — asserted a gate
that did not exist. **The warning was TRUE.** Acting on that finding would have deleted a
true warning about an irreversible act, which is a worse outcome than the bug it claimed
to fix.

🔴 **An absence in the CLIENT's type declarations is evidence about the SDK's
DOCUMENTATION, never about the server.** A `.d.ts` lists the rejections its author chose
to document. For any question of the form *"is this call gated?"* the authority is the
tRPC procedure in `civitai/civitai`, and nothing else settles it. Same family as the
general rule that an empty result cannot distinguish two mechanisms: "the identifier is
not in the SDK" is equally consistent with "there is no gate" and "the gate is not
documented", and only the server tells you which.

### The consequence for any app-block board or gallery

Publish being author-only while `append` is open to every trusted viewer is an
**asymmetry, not a matched pair**, and it produces an impersonation surface that is easy
to miss: `getImages` resolves images **the app** published — not "images this viewer
published" — so a non-author can read a genuine entry's image ids out of a gallery,
`append` their own row carrying those same ids, and have **real images** render under
whatever provenance the app's UI asserts. Any "posted by the app author" claim must
therefore be gated on the host-stamped `authorUserId` that `list` returns, never inferred
from the fact that publishing is restricted.

## 19. 🔴 The capture VIEWPORT is not stable, and `emulate` cannot be trusted to fix it

Two findings from the sessions that probed the shoot route. **Provenance: both were
measured by earlier sessions in this arc and are recorded here rather than
re-derived — the emulate one in particular has not been re-measured since.**

### 19a. Four different viewports in ONE session, unprompted

Measured capture viewports across a single session: **`1709x1255`, `3431x1286`,
`1135x1314`, `849x1255`** device px. The cause is **i3 tiling** — Brave resizes
with the workspace, and `devicePixelRatio` is `1.140625`, so the device-pixel
numbers a recipe records are a product of two things that both move.

🔴 **Consequences, and the second is the one that bites a recipe author:**

- **Resizing the window back is not a durable fix.** It holds only until the next
  re-tile, which happened **three times unprompted** in one session.
- **A recipe pinned to a measured viewport is pinned to an accident.** This is why
  §15's max-width finding needed TWO captures at different widths to interpret: at
  3431 px `custom-generators` showed 803 px of slack on each side, at 1709 px it
  showed `leftInset=0, rightGap=-1` — the same app, opposite readings, and one
  width alone cannot tell a max-width container from a full-bleed one.

**So: never conclude anything about an app's framing from ONE capture.** Take two
at different widths, and read `APPFRAME_RECT`'s `leftInset`/`rightGap` at both.

### 19b. `emulate` reports success while the page still reads its OLD size

🔴 **The instrument lies in the reassuring direction.** Setting a viewport via
`emulate` returns success, and a `js` read taken from the page afterwards comes
back with **pre-emulation values** — so the confirmation you would naturally reach
for confirms nothing, and a capture can proceed at a size you believe you set.

This is the "validate the INSTRUMENT before you read its verdict" rule landing on
a viewport: the op's own success reply is a claim about the OP, not about the
page. If the emulate route is ever built out, its acceptance test cannot be the
op's return value — it has to be a dimension read the PAGE agrees with, taken
after whatever settle the renderer needs.

⚠️ **This does not need solving today.** Viewport pinning via `emulate` was
evaluated 2026-09-02 and explicitly NOT shipped — the record is
`.claude/skills/app-capture/reference/cropping-and-attaching.md` § "Viewport
PINNING", and the capture scripts contain no `emulate` support at all
(`grep -rn emulate` over `.claude/skills/app-capture/scripts/` returns nothing).
The rollout's rank 5 settled on the declared anchored `crop.rect` instead. 19b is
recorded because it is the reason the route is *unverifiable* as well as unbuilt —
which is a stronger argument against reviving it than "nobody built it yet".

## 20. 🔴 CONSENT PERSISTS ONCE GRANTED — so a "declined consent" check is unreachable after the accepted run, and reading the confirmations in their written order costs a second PAID generation

`taste.json`'s `deferred[4]` closing condition lists three confirmations in the
order (1) the consent dialog reads sensibly, (2) the kept image survives a full
page reload, (3) a deliberately-declined consent leaves the run intact. **Run them
in that order and (3) is unreachable**, because (2) requires *granting*
`ai:write:budgeted`, and once granted the host stops raising the dialog. Recovering
from that means revoking the grant under Apps → Permissions, or paying for another
generation.

**The order that works** — measured end to end against live `custom-generators`
0.7.1 on 2026-09-18, one paid generation total:

1. open the Runner, type a prompt, press `grant-consent` → the host dialog appears
   → screenshot it — that is confirmation **(1)**;
2. **decline** it (`Not now`) → assert `consent-needed` present, `runner-error`
   absent, prompt text still in `runner-prompt` — that is confirmation **(3)**, and
   it costs nothing;
3. press `grant-consent` again → **Allow** → generate → Keep → full reload → My
   gallery — that is confirmation **(2)**, and it is the only step that spends.

Two facts that are easy to get backwards and each cost a round:

- 🔴 **The dialog in (1) is the GENERATION-BUDGET consent, not post-from-app.**
  It is raised by `requestConsent({ scopes: [AI_WRITE_BUDGETED] })` in the app's
  own `<custom-generators>/src/App.tsx`. So this whole check is reachable while the
  `app-blocks-post-creation` flag is still dark — the two are independent, and
  treating the dialog as the post-from-app publish consent deadlocks the taste
  check against a flag rollout that does not gate it.
- 🔴 **Keep raises a SECOND host dialog of its own** ("Waiting for you to confirm
  in the Civitai dialog…"). It is a confirm, not a second spend — but a script
  that assumes one dialog per run stalls there waiting for a result that needs a
  top-frame click first.

⚠️ **The consent dialog is HOST chrome and renders in the TOP frame, not in the
block's iframe** — that is the security property the check exists to test. Drive
the block's own controls with `--frame`; drive the dialog *without* it. A driver
that sends every click into the iframe will never find the dialog's buttons and
will report the dialog as absent.
