# Comped membership gifts

A moderator can give a member a membership gift that nobody pays for. It uses the same gift system
as a paid gift (`membership-gift.service.ts`): the recipient is notified and emailed, accepts it
themselves, and the months arm one at a time. Only the payment step is skipped.

## Who can

Moderators holding the moderator-app permission `user.membership.gift.comp`. The main-app endpoints
check it on every call (`hasModeratorGrant`), and the moderator app shows the panel only to holders.
Like every new permission, nobody holds it until a role is granted it on the moderator app's
`/admin` page.

## Where

- Moderator app: the **Gift a membership** panel on the user lookup page. Preview first, then confirm.
- `POST /api/mod/membership-gift/comp`: `userId`, `tier` (bronze, silver, gold), `months` (1 to 12),
  `reason` (10 to 500 characters, staff only), optional `message` and `anonymous`, and `execute`.
  A dry run unless `execute=true`.
- `POST /api/mod/membership-gift/comp-revoke`: `giftId`, `execute`. Takes back a comp made by
  mistake, before the recipient accepts it. Refuses paid gifts and accepted comps: acceptance can
  move the holder up a tier, so taking one back afterwards needs an engineer.

## Rules

- The acting moderator is the gifter of record.
- Refused: a deleted, banned or muted recipient; the moderator's own account; a membership billed
  by a provider gifts cannot reach.
- At most 10 comps per moderator in any 24 hours, counted from ModActivity under a per-moderator
  lock.

## What Stripe sees

Nothing at comp time. Once the recipient accepts, the months arm exactly as a paid gift's do: a
month coupon on their own subscription (free months, or the gift's cash value off the bill when
they hold a higher tier or are not billed monthly), or, with no membership, a free subscription at
the gift tier. A comp has no payment intent, so Stripe refund and chargeback webhooks never match
it.

## Audit

- The moderator-endpoint audit row: who, when, the full input including `reason`, and the gift id.
- A ModActivity row against the recipient (`compMembershipGift:<tier>:<months>`), written in the
  same transaction as the gift. A revoke writes `revokeCompMembershipGift:<giftId>`.
- An Axiom line (`membership-gift`, stage `comp` / `comp-revoke`).
- In the database, a comp is a `MembershipGift` with `amountCents = 0` and no Stripe checkout or
  payment id.
