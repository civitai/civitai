# Generator Announcements

> Status: **Proposal** · Owner: Briant · Source: [ClickUp 868k0b98x](https://app.clickup.com/t/868k0b98x)

## Goal

Let moderators publish announcements that surface **inside the generator** (not just the
site-wide banner area). A generator announcement opens as a **non-dismissible modal** the user
must acknowledge with **"OK"** — matching the ClickUp ask ("a window people have to click OK for
special announcements dealing with the generator").

There is no severity/`level` split and no inline banner: a generator announcement *is* the
acknowledge modal. Clicking OK records the dismissal in the existing localStorage store, so it
won't show again. **No new tables, no backend ack tracking** — announcements are short-lived and
client-side dismissal is sufficient.

## Why reuse, not rebuild

The repo already has a complete announcement stack — model, mod CRUD, Redis caching,
time-windowing, domain + audience targeting, a render component, and a dismissal store. We only
need to **scope** an announcement to the generator and render it as a modal.

| Piece | Location |
| --- | --- |
| `Announcement` model | [prisma/schema.full.prisma:2518](../../prisma/schema.full.prisma#L2518) |
| Metadata zod schema | [announcement.schema.ts:9](../../src/server/schema/announcement.schema.ts#L9) |
| Service (filter/cache) | [announcement.service.ts:76](../../src/server/services/announcement.service.ts#L76) |
| Router (public + mod) | [announcement.router.ts](../../src/server/routers/announcement.router.ts) |
| Render component | [Announcement.tsx](../../src/components/Announcements/Announcement.tsx) |
| Client fetch + dismiss store | [announcements.utils.ts](../../src/components/Announcements/announcements.utils.ts) |
| Generator layout | [GenerationLayout.tsx](../../src/components/generation_v2/GenerationLayout.tsx) |

## Data model changes

No new `Announcement` columns — everything rides on the existing `metadata` JSON. Add a single
field to `announcementMetaSchema` in [announcement.schema.ts](../../src/server/schema/announcement.schema.ts):

```ts
// added to announcementMetaSchema
placement: z.enum(['site', 'generator', 'both']).default('site'),
```

`placement` controls **where** the announcement renders. Existing announcements default to
`'site'`, so current behavior is untouched. Anything including `'generator'` shows as the
generator modal.

### Acknowledgment

The OK click reuses the **existing localStorage dismissal store**
([announcements.utils.ts](../../src/components/Announcements/announcements.utils.ts) — `dismissAnnouncements` /
`useAnnouncementsStore`). The store already self-prunes ids that are no longer live, so this is
sufficient — **no new table, no per-user DB tracking.**

> Trade-off: dismissal is per-browser, so an announcement can reappear if the user switches
> devices or clears storage. Acceptable given how short-lived these are.

## Backend

The only backend change is the schema. There is **no new model, migration, or mutation.**

1. **Schema** — add the `placement` metadata field (back-compat via the `'site'` default).
2. **Service** — no change. `getCurrentAnnouncements` filtering is untouched; `placement` is read
   client-side off `metadata`.

## Frontend

### Selecting generator announcements

Add a small hook beside `useGetAnnouncements`:

```ts
// useGetGeneratorAnnouncements()
const { data } = useGetAnnouncements();
return data.filter(
  (a) => a.metadata.placement === 'generator' || a.metadata.placement === 'both'
);
```

This piggybacks on the already-SSR-seeded query — no new network cost.

### The acknowledge modal

A `GeneratorAnnouncementGate` component mounted in the generator:

1. Take generator announcements (`placement` includes `'generator'`).
2. Drop any already in the localStorage dismissal store (`useAnnouncementsStore`).
3. If any remain, open a single blocking Mantine modal (use the existing dialog pattern from
   [CompatibilityConfirmModal.tsx](../../src/components/generation_v2/CompatibilityConfirmModal.tsx)) that
   **lists all** undismissed generator announcements (title + markdown content each — the existing
   `<Announcement>` card can be reused for each row) with one **"OK"** action at the bottom.
4. On OK → call `dismissAnnouncements(ids)` for every announcement shown (the store already
   accepts an array), which closes the modal.

The modal is non-dismissible (no X, no click-outside) so the user has to click **OK**. The OK
*is* the dismissal.

## Authoring (mods)

Reuse the existing mod announcement admin UI. Just expose one new field:

- **Placement** select (Site / Generator / Both)

No separate admin surface needed.

## Scope

Generator-wide targeting only. Announcements show in the generator regardless of selected
ecosystem/model — there's no per-ecosystem targeting (not part of the ClickUp ask).

When multiple generator announcements are live at once, they're **listed together in a single
modal** with one OK action, rather than shown one-by-one.

## Trigger behavior

The modal applies to **any user with the generation panel open**. Because the
`GeneratorAnnouncementGate` is mounted inside the generation form/panel, it only renders (and
therefore only fires) when the panel is present — which it always is on the `/generate` page.
A user merely browsing elsewhere, with the panel closed, won't be interrupted. No extra
"is the panel open?" check is needed; mount location handles it.
