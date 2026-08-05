// App Blocks — the GATE on the iframe init-fragment fast path.
//
// WHY THIS EXISTS
// ---------------
// The fragment fast path (see `blockIframeUrl.ts`) appends
// `#civitai-block=v1&…` to a third-party block's iframe URL. A live-block
// enumeration on 2026-08-05 established two facts that together make an
// UNCONDITIONAL append the wrong default:
//
//   1. 🔴 NO DEPLOYED BLOCK CAN DECODE IT. Across all 20 live bundles,
//      `civitai-block=v1` x0 and `BLOCK_HELLO` x0. The SDK half is merged but
//      NOT published (npm latest is still `@civitai/app-sdk@0.30.0`). So the
//      fast path currently buys exactly nothing, and "zero benefit" is the
//      decisive argument, not the risk level.
//   2. 🔴 THE `iframe.src` NO-STOMP GUARD PROTECTS AN EMPTY SET.
//      `stampCanonicalIframeSrc` (server-side) UNCONDITIONALLY overwrites
//      `manifest.iframe.src` with `https://<slug>.<appsDomain>/`, and the
//      manifest schema independently rejects a dev-set `iframe.src`. So no
//      production block's src can ever arrive carrying a fragment, and the
//      no-stomp branch in `buildBlockIframeSrc` cannot fire for one. It is
//      retained as a cheap correctness property, NOT counted as a mitigation.
//
// So the fast path is OFF by default, everywhere, and turns on per block only
// once that block ships an SDK that decodes it.
//
// 🔴 THIS IS AN OPT-IN ALLOWLIST, NOT A RUNTIME KILL SWITCH. Enabling or
// disabling a block is a deploy. That is an honest limitation and it is stated
// here rather than in a commit message: with `ALLOWLIST` empty the feature is
// inert, so there is nothing to revoke in a hurry, but if a runtime switch is
// wanted the right home is a feature flag in the flags service — outside this
// module and deliberately not added here.

/**
 * The surfaces that can mount an iframe block host. Passed explicitly by each
 * `PageBlockHost` call site rather than inferred, so that adding a new PAGE
 * host is a type error until someone decides what it should do.
 *
 * ⚠️ That type-error guarantee covers `PageBlockHost` ONLY. `IframeHost`
 * hard-codes `surface: 'model-slot'` internally, so a new MODEL-slot host would
 * inherit that literal silently rather than being forced to choose.
 */
export type BlockHostSurface =
  /** `IframeHost` in a model-page slot (`model.sidebar_top`, …). */
  | 'model-slot'
  /** The full-page run host, `/apps/run/<slug>`. */
  | 'page-run'
  /** The author's dev tunnel, `/apps/dev/<blockId>`. 🔴 Never eligible. */
  | 'dev-tunnel'
  /** Moderator review surfaces (review modal + full-page preview). */
  | 'review-preview';

/**
 * Blocks permitted the fragment fast path, keyed by `blockId` OR `slug`
 * (whichever the surface knows — the model slot has a `blockId`, the page host
 * has both).
 *
 * 🔴 KEYING ASYMMETRY — READ BEFORE ADDING AN ENTRY. The page host knows BOTH
 * a `blockId` and a `slug`; the MODEL SLOT knows only a `blockId` (`BlockInstall`
 * has no `slug` field at all). So an entry written as a slug silently does
 * NOTHING on the model slot. When enabling a block, add its `blockId` — or add
 * both — and verify on the surface you actually care about.
 *
 * 🔴 EMPTY MEANS THE FEATURE IS OFF EVERYWHERE. That is the intended state
 * until blocks rebuild against an SDK that decodes the fragment. Adding an
 * entry is a deliberate, per-block decision that should be made only once THAT
 * block is known to ship a decoding SDK — the fragment is inert to a block that
 * does not read it, but a block that reads `location.hash` for its OWN purposes
 * can be perturbed by it (see DENYLIST).
 */
export const BLOCK_INIT_FRAGMENT_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Blocks that must NEVER receive the fragment, whatever the allowlist says.
 *
 * `playable-collections` reads `location.hash` on first load and strips it
 * afterwards. It fails closed against our fragment only BY LUCK — it looks for
 * a `c` key that `civitai-block=v1&theme=…` does not carry. That is a
 * coincidence, not a contract, and it would be silently re-broken by any future
 * change to either side's key set. The denylist is checked BEFORE the
 * allowlist so that whoever eventually widens the allowlist cannot
 * accidentally re-enable it.
 */
export const BLOCK_INIT_FRAGMENT_DENYLIST: ReadonlySet<string> = new Set<string>([
  'playable-collections',
]);

/**
 * May this host append the init fragment to its iframe URL?
 *
 * Order is load-bearing:
 *   1. `dev-tunnel` is refused UNCONDITIONALLY — see below.
 *   2. DENYLIST beats the allowlist.
 *   3. Otherwise, the block must be explicitly allowlisted.
 * Anything unrecognised falls through to `false`.
 *
 * 🔴 WHY `dev-tunnel` AND `review-preview` ARE REFUSED BY CONSTRUCTION.
 *
 * Both mount code that has NOT been reviewed, under an identity an allowlist
 * cannot distinguish from the reviewed one:
 *
 *   - `review-preview` mints `page_<pubreq_…>` for a PENDING, UN-APPROVED
 *     publish request (`publish-request.service.ts`), i.e. a moderator opening
 *     the next unreviewed submission of an app — with a moderator's session, on
 *     a surface every other layer treats as maximum-hazard. And on page-run
 *     `slug === blockId`, so allowlisting a PUBLISHED app would necessarily
 *     enable the fragment on the moderator's preview of that same app's next
 *     unreviewed submission. The dev-tunnel argument transfers wholesale; there
 *     is no version of it that stops at the tunnel.
 *
 * `resolveDevPageBlockForAuthor` applies NO status filter at all — deliberately,
 * so an author can iterate on a draft. The repo says so itself in
 * `src/pages/api/v1/block-tokens/index.ts`: the SSR dev route "mounts an OWNED
 * app at ANY status". It mounts the same real `PageBlockHost` as production, so
 * the fragment would reach ARBITRARY UNPUBLISHED CODE that no query can
 * enumerate — and the PWA starters' own docs (`starters/{react,svelte}-pwa`
 * README / AGENTS.md / `.claude/commands/add-route.md`, five places) steer
 * authors toward exactly the `location.hash` routing this would perturb. It is
 * the one surface where the hazard is live today and structurally unmeasurable.
 *
 * An allowlist keyed on blockId/slug CANNOT cover that case: a block whose id
 * is allowlisted for production is the SAME id the author iterates on through
 * the tunnel. So the surface is a second, independent axis, and it is checked
 * first.
 */
export function blockInitFragmentEnabledWith(
  args: {
    surface: BlockHostSurface;
    blockId?: string | null;
    slug?: string | null;
  },
  allowlist: ReadonlySet<string>,
  denylist: ReadonlySet<string>
): boolean {
  const { surface, blockId, slug } = args;

  // (1) Unconditional: no allowlist entry can enable a surface that mounts
  //     UNREVIEWED code. See the doc comment above for why identity-keying
  //     cannot express this.
  if (surface === 'dev-tunnel' || surface === 'review-preview') return false;

  // (2) Denylist beats everything below it.
  if (blockId && denylist.has(blockId)) return false;
  if (slug && denylist.has(slug)) return false;

  // (3) Explicit opt-in only. Empty allowlist ⇒ false for every block.
  if (blockId && allowlist.has(blockId)) return true;
  if (slug && allowlist.has(slug)) return true;

  return false;
}

/**
 * Production binding of {@link blockInitFragmentEnabledWith} against the real
 * module constants. This is what the hosts call.
 *
 * The lists are injected in the `…With` form rather than read from module
 * scope so the ORDERING guarantees above can actually be TESTED. With the real
 * allowlist empty, every outcome is `false`, and a test written against it
 * cannot distinguish "the dev tunnel was refused first" from "nothing is
 * allowlisted" — a guard that can only ever be observed returning false is an
 * untested guard. See `__tests__/blockInitFragmentGate.test.ts`, which drives
 * the injectable form with a NON-EMPTY allowlist and includes a positive
 * control proving the predicate can return `true` at all.
 */
export function blockInitFragmentEnabled(args: {
  surface: BlockHostSurface;
  blockId?: string | null;
  slug?: string | null;
}): boolean {
  return blockInitFragmentEnabledWith(
    args,
    BLOCK_INIT_FRAGMENT_ALLOWLIST,
    BLOCK_INIT_FRAGMENT_DENYLIST
  );
}
