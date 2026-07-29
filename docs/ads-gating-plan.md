# Plan: let `Gated` suppress ads on civitai.com

Two workstreams from the ad provider's 2026-07 report of ~200 policy-flagged pages:

1. **Stop gated pages requesting ads** — pages already hidden behind the `.red` gate that
   still fire an auction. Implemented; everything up to "Deferred" below.
2. **Audit model names and page content for ad-unsafe text** — pages that are SFW by *our*
   rules but still trip GAM's classifier. See "Workstream 2" near the end.

## Problem

Gated NSFW pages on `.com` still make an ad request behind the "This content has a new
home" card. Measured headless + logged out on 2026-07-27:

| | `/models/1972981/sex-nudes-...` (gated) | `/models/1166008` (control) |
| --- | --- | --- |
| GAM ad requests (`gampad/ads`) | **1** | 1 |
| ad units requested | **`adhesive`** | `side_1`, `side_2`, `adhesive` |
| prebid / SSP auction calls | **1145** | 1443 |
| rendered ad iframes | **1** | 0 |

The request carries `page_url` = the gated `.com` URL. That is what puts the URL into GAM's
inventory and therefore into the policy violation center — our provider reports ~200 flagged
pages currently serving no ads or very low CPMs.

## Scope is narrower than it first looks

**`Gated` already does its job for in-page units.** `side_1`, `side_2`, and `incontent_*`
live inside `{children}` ([`Gated.tsx:218`](../src/components/Gated/Gated.tsx#L218) only
renders children for `state === 'page'`), so on a gated page they are never defined as GPT
slots and never auctioned. The control page defines three slots; the gated page defines one.

The sole leak is **`adhesive`**, rendered from
[`AppLayout.tsx:95`](../src/components/AppLayout/AppLayout.tsx#L95) — *outside* `{children}`,
so the gate cannot reach it:

```tsx
{children}          // line 85  ← Gated lives in here
...
{footer && <AdhesiveFooter />}   // line 95  ← not gated
```

Since a prebid auction only runs for a defined slot, removing the adhesive slot removes both
the GAM request and all 1145 SSP calls.

**We do not need to block `loader.js`.** The Snigel loader, `gpt.js`, and the adengine
bootstrap are inert on their own — they create no inventory without a slot request. Blocking
them would require resolving the gate before `_app` renders (i.e. server-side plumbing
through `getServerSideProps` → `pageProps`), which is a much larger change for no additional
policy benefit. See "Deferred" below for the one residual it would buy us.

## The rule: content rating, not gate state

The decision is about the **content**, not the viewer.
[`isAdGatedContent`](../src/shared/utils/ad-gating.ts) is the whole of it:

```ts
return !!nsfw || !hasSafeBrowsingLevel(contentNsfwLevel);
```

| Content | Ads |
| --- | --- |
| PG | serve |
| PG13 | serve |
| R / X / XXX | block |
| unrated (0) | block — rating unknown |

**civitai.com serves PG *and* PG13**, so a PG13 page is ad-safe even when an anonymous viewer
sees a login gate instead of the content. An earlier cut of this keyed off the `Gated` verdict
(`state !== 'page'`), which blocked ads on every PG13 page for logged-out users — most of the
site's ad traffic. Don't reintroduce that.

It's viewer-independent for a second reason: one auction is enough to put a URL in GAM's
policy violation center, so an owner, moderator, or crawler must not be able to monetize a URL
that's gated for everyone else. No `bypassRating`, no session, no `verifiedBot`. Server and
client evaluate the identical expression, so they cannot disagree and there's no hydration
mismatch.

## The wiring

**SSR** — pages that render `<Gated>` return a rating alongside their props:

```ts
return { props: { id }, gating: { contentNsfwLevel: model.nsfwLevel, nsfw: model.nsfw } };
```

`createServerSideProps` consumes `gating` (it never reaches Next.js), resolves it, and merges
`adsGated` into props. `_app` reads that and passes `<AdsProvider gated={adsGated}>`. The type
is `AdGatingDeclaration`, wired into the resolver signature so a typo'd key fails typecheck.

This has to be server-side: [`AdUnitRenderable`](../src/components/Ads/AdUnitRenderable.tsx#L14)
renders whenever `adsEnabled` is true, including during SSR, so the reserved-height ad slot
ships in the HTML and paints before hydration. An effect is too late — that's the flash.

**Client navigation** — `Gated` calls `useAdGate(isAdGatedContent({ contentNsfwLevel, nsfw }))`.
No SSR HTML to flash there, so a layout effect lands before paint. `createServerSideProps`
skips `ssg` on client-nav data fetches, so the server value is SSR-only by design and these
two mechanisms are complements, not redundancy.

**Where it applies** — one term on the context value, not on the local `adsEnabled`:

```ts
adsEnabled: adsEnabled && !((gated || gateBlocked) && !useDirectAds),
```

Ad units all read `adsEnabled` from context, so this reaches every one of them — including the
adhesive footer that started this, which renders outside the page tree. Meanwhile the
`<Script>` blocks and the adblock probe keep using the ungated local:

- the Snigel loader still mounts on gated pages. It's inert without a slot, and it drives the
  CMP handshake that sets `ready` — skipping it when a session starts on a gated page would
  delay the first ad on every later page by a full round-trip.
- the `.red` adblock probe still runs. It hits our own ad server for detection rather than
  requesting an ad; skipping it would leave `adsBlocked` unresolved for the rest of the
  session, breaking the closeable-bar logic and the `SupportUs` fallback.

**Never applies to `.red`.** It serves direct ads through `CivitaiAdUnit`, already
`browsingLevel`-aware, with no GAM auction and no policy center. `!useDirectAds` enforces it
client-side, `!features.canViewNsfw` server-side.

### Client-side slot teardown

Mostly already handled: `AdUnitContent`'s cleanup calls `googletag.destroySlots()` on unmount
([lines 62-71](../src/components/Ads/AdUnitFactory.tsx#L62-L71)), so a unit that stops
rendering tears down its own slot. Verify that the adhesive unit actually unmounts (rather
than just hiding) when `adsEnabled` flips mid-session, and that no stale slot survives a
transition into a gated page.

### Known gap

Images and posts gate on `forcedBrowsingLevel || nsfwLevel`, where the forced level comes from
contest-collection details. That isn't prefetched for logged-out users, so the server and
client agree for the traffic that matters — but an authenticated user on a forced-level
contest collection can still see the old flash.

### Verification

Run `node scripts/ad-request-check.mjs [origin]`.

**This cannot be verified locally.** `adsEnabled` is hard-`false` when `isDev`
([`AdsProvider.tsx:125`](../src/components/Ads/AdsProvider.tsx#L125)), so a dev server never
requests ads at all and would pass the gated check for the wrong reason. Point the script at
a preview or production deploy.

Pass criteria, logged out:

- gated (R+) URL: `gampad/ads` count **0**, prebid/SSP calls **0**, defined GPT slots `[]`
- control URL: unchanged — 1 request, `side_1` + `side_2` + `adhesive` still defined
- **a PG13 URL, logged out: ads still serve.** This is the case most likely to regress
  silently, since over-blocking looks like "working" on the gated check alone.

---

## Surfaces

Each declares `gating` in its resolver; `<Gated>` is unchanged apart from the `useAdGate` call.

| Surface | `<Gated>` call site | `gating` declared in |
| --- | --- | --- |
| Models | [`models/[id]/[[...slug]].tsx:824`](../src/pages/models/[id]/[[...slug]].tsx#L824) | same file |
| Images | [`ImageDetail2.tsx:319`](../src/components/Image/DetailV2/ImageDetail2.tsx#L319) | `images/[imageId].tsx` |
| Posts | [`PostDetail.tsx:169`](../src/components/Post/Detail/PostDetail.tsx#L169) | `posts/[postId]/[[...postSlug]].tsx` |
| Articles | [`articles/[id]/[[...slug]].tsx:315`](../src/pages/articles/[id]/[[...slug]].tsx#L315) | same file |
| Bounties | [`bounties/[id]/[[...slug]].tsx:202`](../src/pages/bounties/[id]/[[...slug]].tsx#L202) | same file |
| Challenges | [`challenges/[id]/[[...slug]].tsx:473`](../src/pages/challenges/[id]/[[...slug]].tsx#L473) | same file |
| 3D models | [`3d-models/[id]/[[...slug]].tsx:345`](../src/pages/3d-models/[id]/[[...slug]].tsx#L345) | same file |
| Collections | [`Collection.tsx:557`](../src/components/Collections/Collection.tsx#L557) | `collections/[collectionId]/index.tsx` |

The failure mode to watch is a `gating` declaration drifting from its `<Gated>` props. 3D
models gained `useSSG: true` plus a `model3d.getById` fetch — it previously SSR'd a loader
with no `<Gated>` mounted, shipping an ad slot every time.

---

## Open questions

**@ai:\* Should the gate become a real HTTP redirect instead of a 200 card?**
Everything above treats the `200 OK` + render-swap as fixed. If gated `.com` URLs returned
`301`/`308` to `.red`, the ad problem disappears as a side effect *and* the URLs leave GAM's
and Google's inventory entirely — which is the direct answer to the provider's point that
these URLs "still live on the .com domain."

That's the stronger fix, but it costs the interstitial (no explanation of the split, no
"same account / Buzz carries over" reassurance). Workstream 1 is now small enough that it's
worth shipping regardless — but this decision still stands on its own, since a 301 is the
only thing that gets these URLs out of Google's index as well as GAM's inventory.

---

## Workstream 2: audit model names and page content for ad-unsafe text

Workstream 1 only helps pages the gate already catches. Most of the provider's examples are
**not** gated — they are rated SFW by our rules and still got flagged:

| Flagged URL | Why it tripped |
| --- | --- |
| `/models/1166008/undressing-clothes-over-head` | title only — provider notes the image "might appear normal" |
| `/models/452459/krea2-gpt-grand-pussy-truth-or-mist2` | slug, plus description behind "Show more" |
| `/models/2107271/frontbend` | image classifier read the subject as a minor |

The lesson: **our NSFW rating and GAM ad-safety are different thresholds.** A model can be
correctly rated SFW for Civitai and still be unmonetizable. We currently have no
representation of the second thing.

### What already exists

[`entity-moderation.ts:201-204`](../src/server/jobs/entity-moderation.ts#L201-L204) already
queues and scans `Model.name` and `Model.description` through
[`text-moderation.service.ts`](../src/server/services/text-moderation.service.ts), with
policies managed via the XGuard scanner services. This is a tuning and coverage problem, not
a greenfield build — resist writing a parallel scanner.

### Checklist

#### Define the standard

- [ ] Get the full ~200 flagged URL list out of GAM from the provider — ground truth to
      calibrate against, and the regression set for any classifier change
- [ ] Write down the ad-safety standard as distinct from our content policy (Google's
      publisher policies for Adult / CSAE are the source, not our TOS)
- [ ] Decide the label vocabulary — at minimum `adUnsafe` as a boolean; better, a reason code
      so CSAE-adjacent hits can be routed to human review rather than just demonetized

#### Close coverage gaps

- [ ] `ModelVersion.name` is unscanned — there's a `// TODO possibly add modelVersion` at
      [`entity-moderation.ts:180`](../src/server/jobs/entity-moderation.ts#L180). Version
      names render on the page and reach the `<title>`
- [ ] Tags and trigger words — both render on the page, neither is in the queue config
- [ ] Description behind "Show more" — confirm we scan the full field, not a truncated
      preview (the `krea2` example was specifically flagged on hidden text)
- [ ] Page-level text GAM sees but we don't own: `<title>` composition, OG description,
      and on-page comments
- [ ] Slug is derived from `name`, so it's covered transitively — but confirm historical
      slugs don't survive a rename (a clean rename with a dirty legacy slug still serves)

#### Backfill

- [ ] One-off sweep over all published models visible on `.com`, scored against the
      ad-safety standard — this is the bulk of the ~200 and won't be caught by any
      go-forward queue
- [ ] Prioritize by ad impressions, not by model age — a flagged page with no traffic costs
      nothing; `side_1` inventory since 2026-07-13 is where the damage is
- [ ] Reconcile results against the provider's list; anything they flagged that we score
      clean is a calibration failure worth understanding before shipping

#### Wire the outcome

- [ ] `adUnsafe` should suppress ads on that page — reuse the gate store from Workstream 1
      rather than inventing a second suppression path. This is the main architectural payoff
      of doing them together
- [ ] Decide separately whether `adUnsafe` also implies `deIndex`. It shouldn't by default —
      demonetizing is cheap and reversible, deindexing costs organic traffic
- [ ] Route CSAE-adjacent hits to human moderation queue, never auto-action
- [ ] Re-scan on edit — a model renamed after publish currently keeps its original verdict

#### Open

- [ ] Do we demonetize the page, or fix/rename the model? Renaming breaks inbound links and
      is creator-hostile at scale; demonetizing is invisible and reversible. Probably
      demonetize by default and reserve renames for the worst offenders — needs a call
- [ ] Is there an appeal path for creators whose model gets demonetized? Relevant if any
      creator revenue is tied to page monetization

## Deferred: blocking the loader entirely

Suppressing the slot stops the ad request, but Snigel still registers a **pageview** for the
gated URL (loader + adengine still boot). That doesn't create GAM policy exposure, but it does
dilute our pageview-to-request ratio in Snigel's reporting — plausibly part of why the
provider sees "pages delivering no ads."

The `adsGated` prop already tells `_app` before render, so the loader could be withheld by
moving that term onto the local `adsEnabled`. Deliberately not done — it would cost the CMP
handshake on any session that starts at a gated URL (see "Where it applies"). Revisit only if
the provider says the pageview-to-request ratio matters.

## Out of scope (tracked separately)

- `robots.txt` blocks `/search/*` and `/*?query=`
  ([`robots.txt/index.tsx:18,61-62`](../src/pages/robots.txt/index.tsx#L18)) while we serve ads
  there. Google's ad crawlers ignore the `*` group, so they need explicit `AdsBot-Google` /
  `Mediapartners-Google` allow groups — otherwise GAM can't classify those pages and they sit
  at a CPM floor.
- The `side_1` sticky skyscraper shipped 2026-07-13 (`41a8a6ace0`), matching the provider's
  reported July 14 pageview spike. Not a bug, but it widened coverage across all model pages,
  which is why this became visible now.
