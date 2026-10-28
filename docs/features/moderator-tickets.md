# Moderator app: ticket views

`/tickets/moderation` and `/tickets/support` are triage pages (`docs/moderator-app/triage-layout.md`) over the
two queues: the list on the left, the open ticket beside it. `/tickets/<view>/<id>` redirects to
`/tickets/<view>?ticket=<id>`, after checking the ticket still routes to that view (404 otherwise). Each view
is its own page grant. Acting on a ticket is a separate permission:
`tickets.reply` (public reply, private note, status) and `tickets.escalate` ("Send to support": adds the
`sent-to-support` tag and moves the ticket to the support group).

- The URL is the only state: `?q=` (ticket number, subject, requester), repeated `status`, `feature` and
  `topic`, `sent=only|exclude` (support view), `sort=updated|created`, `dir`, `page`, and `ticket` for the open
  ticket. A ticket named by `?ticket=` that the filters or paging leave off the page is still selectable. The
  list and its facet counts come from the snapshot in one load; the description and conversation are fetched
  from `GET /api/tickets/<id>?view=<view>` when a ticket is selected. That endpoint is outside the central
  route gate, so it checks the page grant of the view asked for and answers 404 for a ticket that routes to
  the other view. Reply, status and "Send to support" post a `ticketId` field to the page's own actions;
  a ticket that leaves the list afterwards (other view, resolved or closed) moves the selection on.
  Without the grant a form stays on screen, disabled, with the reason.
- Routing lives in one constant, `TICKET_ROUTING` (`apps/moderator/src/lib/tickets/routing.ts`). Precedence:
  "Waiting on Mod Lead" status → moderation; the `sent-to-support` tag → support; the ticket's Feature field;
  for a ticket with no Feature, the support-ticket router's topic. Setting "Waiting on Mod Lead" hands an
  escalated ticket back to moderation.
- Reads use `FRESHDESK_API_KEY` (`freshdesk.service.ts`, GET-only). Writes use `FRESHDESK_WRITE_API_KEY`
  (`freshdesk-write.service.ts`); customers see that key's agent as the sender, so every reply, status
  change and escalation also adds a private note naming the moderator. There is no fallback between the keys.
- A failed write is reported, never thrown, so the operator's typed reply survives. Network errors,
  timeouts and 5xx are reported as "may or may not have been" done, since the write may have landed.
- Each reply, status change and escalation writes a ModActivity row (`ticketReply`, `ticketStatus`,
  `ticketEscalate`, entity type `ticket`).
- Both views read one shared Redis snapshot of every live ticket (subject, status, Feature, tags, dates,
  requester name; never a body or an email address), not Freshdesk, so a page load costs no Freshdesk calls. The snapshot
  is rebuilt in full from the status searches when missing or six hours old (Freshdesk search returns at most
  300 results per query, so a larger status is read in creation-day windows within an 80-call budget; a short
  read is shown as a warning, and a ticket that three short reads in a row did not list is dropped, so a
  closed ticket cannot linger) and is otherwise kept current by `updated_since`
  deltas, at most one a minute, which also drop tickets that were resolved or closed. A refresh runs behind
  the response under a Redis lock, so one process refreshes at a time and the rest serve the stored copy;
  only the first build is waited on. A refresh that fails keeps the old tickets and shows a staleness
  warning. If the very first build fails, the failure is recorded in Redis and nothing retries it for five
  minutes, however many requests arrive. Replies, status changes and escalations patch that one ticket in the
  snapshot, under the same lock; if a refresh holds it for more than two seconds the patch is skipped and the
  next delta reads the ticket.
- A ticket deleted or marked spam in Freshdesk leaves the snapshot at the next full rebuild, not the next
  delta, because the changed-since list omits such tickets.
- The requester's name comes from the delta reads and from opening a ticket; a ticket the snapshot has not
  seen change since the last full rebuild has none, so searching by name finds only the tickets whose
  requester is known. The email address is never stored in the snapshot, listed or searched: personal data
  does not belong in a shared cache for a search nobody needs yet. The open ticket's detail reads it live from
  Freshdesk, uncached, for a caller with `decisions.support.pii`.
