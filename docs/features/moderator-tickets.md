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
- Freshdesk search returns at most 300 results per query, so a larger status is read in creation-day
  windows within a per-load request budget; a short read is shown as a warning, never silently dropped.
