# Crucible: standalone app, or stay in the main app?

**Decision: stay in the main Next.js app.** Recorded 2026-09-14, delegated to Manuel by Justin in the
2026-09-14 Crucible breakout (ClickUp [868m52bwh](https://app.clickup.com/t/868m52bwh), under milestone
[868m4c364](https://app.clickup.com/t/868m4c364)).

> "I guess you could migrate it to be a standalone app. Currently, it's built into the main app… How about
> you take a look and see where things are at and decide whether or not you think it makes sense to break it
> out into its own thing." — Justin, 2026-09-14

## The short version

Every spoke in `apps/` that renders a UI is SvelteKit. Crucible is 18 React + Mantine files whose entire
surface is the Civitai-specific composites that `docs/packages/new-app-integration.md` says a spoke has to
hand-build: media rendering, NSFW gating, the user's own image library, the upload pipeline, masonry grids.
Breaking it out is not a move, it is a rewrite of the parts that already work, on a stack that does not yet
have the pieces it needs.

## What the evidence is

### 1. There is no React spoke, and the shared UI package is Svelte

| App | Framework |
|---|---|
| `apps/auth` | SvelteKit |
| `apps/creator-studio` | SvelteKit |
| `apps/moderator` | SvelteKit |
| `apps/training-studio` | SvelteKit |
| `apps/event-engine` | service |
| `apps/notifications` | Fastify |
| `apps/orchestrator-gateway` | Fastify |
| `apps/storage` | Fastify |

`packages/civitai-ui` is shadcn-svelte primitives plus a Tailwind v4 theme. `docs/packages/new-app-integration.md`
§0 is explicit about what that leaves an app owner to build:

> "Only **hand-build** what has no ecosystem equivalent — i.e. Civitai-specific composites: `EdgeMedia`/image
> rendering, NSFW `ImageGuard`, masonry grids, moderation toolbars, votable tags."

That list is close to an inventory of Crucible's UI.

### 2. The dependency surface is 68 distinct main-app modules

Counted across `src/components/Crucible/`, `src/components/Cards/CrucibleCard.tsx`, `src/pages/crucibles/`,
`crucible.service.ts`, `crucible.router.ts`, the two jobs and the notification processors. The ones that
decide this are the ones with no `@civitai/*` equivalent:

| Need | Where it lives today | Package equivalent |
|---|---|---|
| Pick from the user's own uploads | `trpc.image.getMyImages` → `image.service.ts` (8K+ lines) + browsing-level merge | none |
| Upload an entry | `useMediaUpload`, `useCFImageUpload`, `@mantine/dropzone`, `IMAGE_MIME_TYPE` | none |
| Render an entry | `EdgeMedia` / `EdgeImage` | none (Svelte spokes hand-build it) |
| NSFW gating | `Gated`, `browsingLevel.constants`, session browsing level | partial, via `event-engine-common` |
| Entry grid | `MasonryColumns/*` | none |
| Modals | the dialog registry (`dialog-registry2.ts`) | none |
| Page shell | `AppLayout/Page`, `Meta` | none |
| Buzz | `buzz.service.ts` | `@civitai/buzz` ✅ |
| Notifications | `notification.service.ts` | `@civitai/notifications` ✅ |
| DB / Redis / ClickHouse / Flipt / auth | main app clients | `@civitai/db`, `-redis`, `-clickhouse`, `-flipt`, `-auth` ✅ |

The bottom five rows are solved. The top seven are the feature.

### 3. Crucible's audience is the one audience the spokes do not serve

Every UI spoke is a staff or creator tool on its own subdomain. Crucible is end-user UGC on civitai.com:
users submit their own images and videos, pay Buzz to enter, judge pairs, and win Buzz. Off-domain it would
have to re-acquire the session, the browsing-level preferences, the image library and the upload pipeline —
all of which it gets for free where it is.

### 4. Two arguments that looked decisive and are not

**Notifications.** Justin raised this as the blocker: he believed apps can't send them. That is true of
**App Blocks** — there is no notification procedure on the block bridge — but not of a monorepo spoke.
`packages/civitai-notifications` names future apps as a producer in its own contract, and `apps/moderator`
already sends through it. So notifications argue neither way.

**Discovery.** The reason to consider standalone was that "the challenges feed isn't actually even very good
right now", with an article or announcement linking to Crucible instead. That link works identically against
`civitai.com/crucibles` and a `crucible.civitai.com`, so discovery is neutral too.

## The argument against this decision, stated fairly

A spoke would isolate blast radius: Crucible currently sits in the same build and deploy as the hot feed
path, and its service imports `image.service.ts`, which is the most-edited file in the repo. That is a real
cost and it is the strongest case for breaking it out.

It is outweighed because Crucible is already behind a Flipt flag (ClickUp 868m54jtk, merged), which buys most
of the isolation at none of the rewrite cost, and because the H3 contest needs four or five crucibles running
a week or two into the training segment. The remaining subtasks — video entries, minimum view time, maximum
clip length, seeded prize pool, hiding the live leaderboard — are days of work in the current stack and a
quarter of work in a new one.

## When to revisit

Both conditions, not either:

1. Crucible becomes a standing product rather than contest infrastructure, **and**
2. the shared packages grow a React-capable, or cross-framework, media + upload story — concretely, an
   `EdgeMedia` equivalent and a `useMediaUpload` equivalent that a spoke can consume.

Until (2) exists, a standalone Crucible has to build them, and that is the whole argument above.
