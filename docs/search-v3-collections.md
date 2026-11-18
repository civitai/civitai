# Search v3: collections

**Status:** Proposal, 2026-11-18. Awaiting a decision from Luis and Justin.

Search v3 makes the header bar search the page you're on. Collections are the main place where it
still doesn't work: a search on `/collections` or inside a collection opens the global search page.
There are two separate jobs here, and they want different answers.

| Job                          | Page                                      | Today                                                             |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Find a collection            | `/collections` (and the header bar there) | No collections feed; the search page only                         |
| Search inside one collection | `/collections/[collectionId]`             | No search at all                                                  |
| A creator's collections      | `/user/[username]/collections`            | Done: name match through the tab's own feed (#9365, `pageSearch`) |

## 1. Searching inside a collection

A collection holds one kind of item (models, images, posts or articles), and its page already
renders that kind's feed (`Collection.tsx`). The header bar should filter that feed in place.

### Options

**A. Local text match.** Each feed filters by its own text (model name, article and post title).

- Cheap and ready now, the same as a creator's tabs.
- Useless for image collections: images have no title, and prompt-text search was dropped on
  purpose (11/17). An image collection would only ever match nothing.

**B. Semantic search over the collection's item ids.** Search the item type's index (images,
models, articles), with the candidates limited to the collection's item ids.

- Article search does this already (`listedArticleIds`, `collectionId` on its input): the ids go
  into the Qdrant filter, so the ranking happens within the collection.
- It is capped (`MAX_INDEXED_LIST_IDS`, 1,000). Above the cap the id filter is dropped. The search
  then ranks over the whole index and hydration keeps only the collection's items, so a large
  collection gets sparse pages.
- Posts have no index, so a post collection can only get A.

**C. A `collectionIds` field on every item's payload.** The index itself answers "in collection X".

- This is the only option with no size cap.
- It rewrites a point on every add and remove, and needs a backfill over the whole images
  collection: the write load the image index can't take on while it is capacity-bound. Not now.

### Recommendation

- **B for image, model and article collections up to the cap.** Image collections are where search
  matters most, and B is the only option that works for them.
- **A for post collections**, and for model and article collections over the cap, where a name
  match beats sparse pages. For image collections over the cap, keep B's sparse pages, since A
  matches nothing there.
- **Revisit C** after the image Qdrant capacity fix, if over-cap collections turn out to matter.

To build:

- add `collectionId` to the image and model search inputs (the same shape as articles), and share
  one `listedIds` helper with the article search;
- add `/collections/[collectionId]` as an in-place search target;
- have each feed on the page answer `?query=`.

All of it goes behind `pageSearch`. Contest collections during judging keep their own rules: the
search uses the same hydration, so a hidden entry stays hidden.

**To measure before choosing the cap:** how many collections, and how many collection views, are
over 1,000 items, per item type. It is the one number this choice turns on.

## 2. Finding collections

**Data.** vector-sync already builds a collections index (`apps/event-engine/src/vector-sync/collections`).
Its payload holds the title and document text, `type`, `mode`, `nsfwLevel` and `userId`. The search
service does not serve it yet (its `/healthz` lists articles, bounties, challenges, crucibles, images
and models). Ask the search lead to serve `collections`.

**Search results.** A query on `/collections` shows a feed of matching collection cards:

- filters for item type and for leaving out bookmark collections;
- hydrated through the existing collection read path, so private collections and browsing levels
  are enforced there and not by the index.

**Before the index is served,** the same page can use a name match on public collections. That is
a prefix match, as on a creator's tab, behind `pageSearch`, and it gets the bar working on this
page now.

**Landing page with no query:** this needs a design Justin approves. A starting point: your recent collections, collections you follow, and popular public
collections. "Popular" needs an order. Follower count is the natural one, and it lines up with the
planned public-collections browse, which filters by item count and follower count.

## Proposed order

1. Inside a collection, B and A as above, behind `pageSearch`. This is site-only work and needs
   nothing from the search service.
2. The `/collections` name match, behind `pageSearch`.
3. Serve the collections index (search lead), then switch the `/collections` search to it.
4. The landing page, once its design is approved.

## Decisions needed

- Luis: B with the 1,000 cap (after the measurement) and A for posts. Yes or no?
- Luis and Justin: the landing page sections, and whether "popular" means follower count.
- The search lead: when the collections index can be served, given the capacity work.
