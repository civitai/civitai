# Moderator app: ticket views

`/tickets/moderation` and `/tickets/support` list Freshdesk tickets for the two queues; `/tickets/<view>/<id>`
opens one. Each view is its own page grant. Acting on a ticket is a separate permission:
`tickets.reply` (public reply, private note, status) and `tickets.escalate` ("Send to support": adds the
`sent-to-support` tag and moves the ticket to the support group).

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
  requester name; never a body), not Freshdesk, so a page load costs no Freshdesk calls. The snapshot
  is rebuilt in full from the status searches when missing or six hours old (Freshdesk search returns at most
  300 results per query, so a larger status is read in creation-day windows within an 80-call budget; a short
  read is shown as a warning, never silently dropped) and is otherwise kept current by `updated_since`
  deltas, at most one a minute, which also drop tickets that were resolved or closed. A refresh runs behind
  the response under a Redis lock, so one process refreshes at a time and the rest serve the stored copy;
  only the first build is waited on. A refresh that fails keeps the old tickets and shows a staleness
  warning. Replies, status changes and escalations patch that one ticket in the snapshot.
- A ticket deleted or marked spam in Freshdesk leaves the snapshot at the next full rebuild, not the next
  delta, because the changed-since list omits such tickets.
- Requester name and address come from the delta reads and from opening a ticket; a ticket the snapshot has
  not seen change since the last full rebuild has none, so searching by name or address finds only the
  tickets whose requester is known. The address is stored in the snapshot, returned and searched only for
  a caller with `decisions.support.pii`.
