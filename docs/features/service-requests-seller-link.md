# Service Requests page: link to Incoming requests

**Status:** built, display only.

## Problem

`/services/deals` lists the requests a user made as a buyer. A seller's incoming requests live on
their shop Manage page (`/user/<username>/shop/manage`, Services tab, "Incoming requests"), and
nothing on the Service Requests page pointed there, so sellers looking for them there found none.

## Decision

- A viewer with at least one service offering (including ones hidden off this domain) sees one line
  under the page title: "Requests to your services are on your shop page: Incoming requests". It links
  to `/user/<username>/shop/manage?tab=services`. The Manage page already opens the Services tab for
  that query.
- The link needs the `creatorShop` flag too: the Manage page redirects to the profile while it is off.
- A viewer with no offerings sees the page exactly as before.
- Display only: no new query, no change to the offering form or card, no change to who can see which
  deal. "Has offerings" reuses `creatorService.getMine` through `useQueryMyServices`.
- The link also shows in the paused-services view, where the page lists "Requests to you" inline.

## Not done

- No anchor to the "Incoming requests" heading; the Services tab is a short page.
- No incoming list on `/services/deals` itself.
