# CSAM text holds queue

A moderator-app queue at `/csam/text-holds` (sidebar: Images > Text holds) listing every Pending
`TextScanHold` row with label `csam`, oldest first. Each item shows the held text as the scan
composed it, the model's reason, the author, when the hold and the content were created, the prompt
id and the workflow id, with a link to the content where one exists. It can be narrowed to one
entity type.

## Where holds come from

The text-scan callback writes a hold when the `csam` label is in review mode and the verdict is
positive; nothing else happens to the content or its author. See the hold paragraph in
[text-scan.md](text-scan.md).

Holds are their own table rather than a `CsamReport`, a `Report` or a key in `Model.meta`: csam text
must never reach the user-facing report queue or an entity's meta, and nothing automated acts on it.

Thirty days after a hold is decided, the daily `text-scan-retention` job clears its text and meta;
the row, reason, ids and decision stay.

## Decisions

- **Dismiss** (with an optional moderator-only note, up to 500 characters) sets the hold to
  `Dismissed` and records who decided it and when. It changes nothing on the content or the account.
  The main app's `/api/mod/text-scan/csam-hold/resolve` owns the write and refuses (409) a hold that is
  missing or no longer Pending. Each decision is logged to Axiom (`text-scan` / `csam-hold-decision`).
- **Confirm** is not offered yet; it is pending a product decision. Until then, a moderator escalates
  by hand through the "File CSAM report" link on the item.

## Access

- The page is granted on its own path. Migration
  `20261101120000_moderator_csam_text_holds_page` copies the roles of `/images/csam` onto it; it is
  applied by hand. Until it runs, only `moderator:admin` can open the page.
- Nav visibility = page grant; opening the page and acting = `csam.report.file`. The page load
  refuses (403) a moderator without that permission, the form action checks it again, and so does
  the main-app endpoint.
- The sidebar badge (`csamTextHolds`) counts Pending csam holds and refreshes with the sidebar cache.
