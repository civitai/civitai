# Guided tours

Short, spotlit walkthroughs that introduce a product surface the first time someone lands on
it — the generator, the post editor, the auctions page. A tour dims the page, highlights one
element at a time, and explains what it does.

They exist because the surfaces they cover are the ones people arrive at cold. The generator
is the site's main product and its first screen is a prompt box, a terms gate, a cost display
and a queue — obvious once you know, opaque before. A tour is the cheapest way to say "this is
the part that matters" without adding permanent UI that everyone then has to dismiss forever.

## The tours

Six, keyed and registered in `src/components/Tours/tours/index.ts`. The key is also the
`?tour=` URL parameter that starts one manually.

| Key | Where it runs | How it starts |
|---|---|---|
| `content-generation` | the generator | automatically, once the form is ready |
| `remix-content-generation` | the generator, when remixing an image | automatically, same trigger |
| `post-generation` | the post editor | automatically, on load |
| `auction` | the auctions page | automatically, on mount |
| `model-page` | a model page | `?tour=model-page` |
| `welcome` | a model page | `?tour=welcome` |

The four that fire automatically do so for every user who has not finished them — the
`appTour` feature flag is `['public']`, so there is no audience gate. Every tour also has a
help button that restarts it on demand; the two generator tours share one, as do the two that
run on a model page.

A tour is not always the whole array. Steps whose targets only exist for some users are
filtered before the tour starts: the generator tour is cut short for a signed-out user, and
the terms step is dropped for someone who has already accepted them.

## How it works

Built on [`react-joyride`](https://github.com/gilbarbara/react-joyride). Five pieces:

- **`ToursProvider`** — owns which tour is running, which step it is on, and whether it is
  paused. Every other piece talks to it through `useTourContext()`.
- **`tours/*.tour.tsx`** — the step arrays. A step names a target, some copy, and optionally
  a `data.onNext`/`onPrev`/`onBeforeStart` hook that runs during the transition (navigating to
  another page, opening a panel, waiting for an element to appear).
- **`joyride-callback.ts`** — translates Joyride's event stream into provider calls. This is
  where the lifecycle actually lives; `LazyTours.tsx` is the thin React wrapper that mounts
  Joyride and injects the DOM-touching pieces.
- **`TourPopover`** — the tooltip. Custom, so tours match the rest of the site.
- **`utils/faro/tour.ts`** — telemetry.

Steps find their target through a `data-tour="<key>"` attribute on the element. That is the
only coupling between a tour and the product code it describes — with one exception, below.

### Steps that require an action

Some steps deliberately have no "Next": the way forward is to do the thing the step is
describing. Accepting the terms is the clearest case — the tour must not offer a way past it,
because clicking past would skip the acceptance itself.

Those steps set `hideFooter` and let clicks through to the highlighted control, and the
component behind them calls `helpers?.next()` when the action completes. That is the second
coupling, and the more expensive one: a `data-tour` attribute is a grep away from its tour, but
a `helpers?.next()` call inside a submit handler is not.

When a required control is legitimately disabled — no Buzz, a pricing error, a full queue —
the tour would otherwise strand the user with no way forward and no way out. The provider
tracks a `blockedTarget`, and a step whose own target is blocked gets its footer back so the
user can move on. It is scoped to that one step: a step that hides its footer for a different
reason never inherits it.

### When a step's target isn't there

Targets are conditional far more often than they look. A remix button renders only for media
the generator can actually remix; a download section renders only when there are visible files;
tabs render only when there is more than one. A tour written against a full-featured page will
meet missing targets on a sparser one.

**A missing target, or a step hook that fails, does not end the tour.** It records the failure
and moves on. A tour that limps through three steps is worth more than one that vanishes, and
the recorded failures are what make the gap visible later.

### Completion

Completion lives in `User.settings.tourSettings` for signed-in users, with `localStorage` as
the fallback. A tour that ends is marked completed **whatever the reason** — finished, skipped,
dismissed, or degraded. That is deliberate: every tour can be restarted from its help button,
so persisting completion costs a user nothing, while *not* persisting it would re-fire a broken
tour on every page load forever.

🔴 **The consequence for anyone reading the data:** a tour that ended is not necessarily a tour
that worked. `tour_end` carries a `reason`, and the `tour_step` events before it carry
`resolved`. A `reason=finished` preceded by a run of `resolved=false` steps is a tour that
skipped most of itself. A completion-rate panel built on `tour_end` alone counts those as
successes.

Progress and completion are written as the tour runs, so several writes for one tour can be in
flight at once. They are merged per-tour and per-field server-side — without that, a completion
lands and is then overwritten by a slower progress write, and the tour re-fires forever.

## Telemetry

Three Grafana Faro RUM events, emitted from the tour callback and queryable in Loki by
`event_name` / `event_data_*`:

| Event | Carries |
|---|---|
| `tour_start` | which tour, and whether it started automatically, from a URL, or from the help button |
| `tour_step` | which step, its target, whether the target resolved, and how long a step hook took |
| `tour_end` | which step it ended on, and why |

Faro events rather than OpenTelemetry spans because browser traces are sampled at roughly a
tenth of sessions while events are not — and a funnel measured on a tenth of its population
cannot answer the question a funnel is for. The LogQL starting points are in `tour.ts`'s
header.

Telemetry rides the `faro` feature flag and the `NEXT_PUBLIC_FARO_*` build args, so there is no
tour data in development or preview.

## Adding a tour

1. Write the step array in `tours/<name>.tour.tsx` and register it in `tours/index.ts` — that
   registration is what extends the `TourKey` union.
2. Add `data-tour` attributes to the elements the steps point at.
3. Start it: an effect calling `runTour({ key })`, a `?tour=` link, or both.
4. Add a help button so it can be restarted, gated on the `appTour` feature flag.
5. For a step that crosses pages, give it a `data.onNext` that navigates and waits for the
   destination element.
6. For a step that requires an action, set `hideFooter` and `spotlightClicks`, and call
   `helpers?.next()` from the component when the action completes.

Two things that are easy to miss. If the target sits under one of Joyride's layers it needs an
explicit z-index to be clickable — clearing the overlay's is not enough, because the tooltip is
drawn above it. And if the target mounts late, point the step at a stable wrapper instead and
check that the scroll helper handles its height.

A test asserts that every step target is an attribute some component actually renders, so a
step pointing at nothing fails there rather than silently vanishing for users.

## Known limits

- **Signed-out completion never reaches the server.** Finish a tour logged out, sign in
  elsewhere, and you get it again.
- **Re-running a tour from the help button does not save progress.** Quit halfway through a
  re-run and the next one starts from the beginning.
- **A handful of product components carry tour code** — the `helpers?.next()` calls behind
  action-required steps, plus the login redirect, which pauses a tour and carries `?tour=` back
  through OAuth. That is the part most likely to break when those components are refactored,
  and nothing enforces the coupling.
- **End-to-end coverage is partial.** `tests/tours.spec.ts` covers the tours opening and
  advancing; the scenarios needing a full walk are marked `test.fixme` with what each is
  blocked on, because walking a tour means clicking real product controls rather than a Next
  button.
- **`react-joyride` is pinned to v2**, which does not support React 19. v3 supports it and
  replaces several things this system hand-rolls. That upgrade is not scheduled and should be
  its own change.
