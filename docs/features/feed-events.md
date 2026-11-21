# Feed events

Civitai records how people use its feeds: which feeds and pages they browse, the sort and filters
they pick, how far they scroll, which items appear on screen, and which they click. This page says
exactly what is recorded and why. The code is public; the table definition is
`src/server/clickhouse/migrations/2026-11-20-feed-events.sql`.

## What it is for

- **Creators:** showing where their views and clicks come from (which feeds, sorts and filters),
  so they can see what works.
- **Us:** knowing which feeds, sorts and filters people actually use and where traffic goes, so we
  build better ones.

It is never used for payouts, points, rewards or ranking content.

## What is recorded

One row per event, for a sample of browser sessions (the share is set in Flipt):

| Field                          | What it holds                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| time, event                    | when; one of `load` (a page of a feed loaded), `seen` (items that were on screen for about a second), `click`                                                              |
| userId                         | your account id, or 0 when signed out                                                                                                                                      |
| memberType                     | your membership tier, or `undefined` for free and signed-out visitors                                                                                                      |
| sessionKey                     | a random token made fresh in each browser tab and not saved in your browser; impression counts use the same token                                                          |
| feed, page                     | which feed (models, images, posts, articles, search) and the page pattern, e.g. `/models`                                                                                  |
| sort, pageIndex                | the sort you chose and how many pages down you are                                                                                                                         |
| filters                        | the filters you set, by name from a fixed list per feed (for example `hidePaid`, `baseModels`, `period`, `browsingLevel`), with the option values the filter controls send |
| entityType, entityId, position | on a click: what you clicked and where it was in the feed                                                                                                                  |
| seenIds                        | on a seen row: the items that were on screen                                                                                                                               |

## What is not recorded

No IP address, no browser or device details, no page URL, and no search text. Filters that
name a person, a tag or a post (and the search box) are not on the list, so they are never stored.

## How long it is kept

90 days, then deleted automatically.
