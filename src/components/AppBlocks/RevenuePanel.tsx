import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { AppsTableColgroup, APPS_REVENUE_COLUMNS } from '~/components/Apps/appsWideLayout';
import { trpc } from '~/utils/trpc';

/**
 * Mirrors `RevenueUnavailableReason` in
 * `~/server/services/blocks/buzz-attribution.service` — redeclared here because
 * that module pulls in `dbRead` and is not client-safe. Keep in lockstep: if the
 * server union grows a value, this component needs a branch for it.
 */
type RevenueUnavailableReason = 'notEntitled';

/**
 * 🔴 EXHAUSTIVE on the union, so a second value cannot silently inherit the
 * notEntitled sentence.
 *
 * The docblock above asks a future author to "add a branch"; that was an instruction with
 * nothing enforcing it — the render only tested `unavailable` for truthiness, so widening
 * the union would have shown confidently WRONG copy on a money screen rather than an
 * obviously missing branch. The `never` assignment makes it a COMPILE error instead: add a
 * value to the union and `tsc` fails here until the copy exists. `AppAnalyticsPanel` uses
 * a value-branch for the same reason.
 */
function unavailableMessage(reason: RevenueUnavailableReason): string {
  switch (reason) {
    case 'notEntitled':
      return 'Your account does not have access to app revenue reporting yet. No earnings were measured — this is not a report of zero earnings.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

type SummaryShape = {
  pending: { count: number; grossCents: number; shareCents: number };
  confirmed: { count: number; grossCents: number; shareCents: number };
  paidOut: { count: number; grossCents: number; shareCents: number };
  voided: { count: number; grossCents: number };
};

type RecentRow = {
  id: string;
  attributedAt: Date | string;
  scope: string;
  buzzAmount: number;
  usdAmountCents: number;
  appOwnerShareCents: number;
  status: string;
  voidedReason: string | null;
  appBlockId: string;
};

/**
 * Mirrors `GoodsUnavailableReason` in
 * `~/server/services/blocks/buzz-attribution.service`. Separate from the
 * payload-level union above: that one means the WHOLE payload is a placeholder,
 * this one means one bucket of an otherwise-real payload could not be read
 * (`block_good_purchase` is applied by hand per environment).
 *
 * ⚠️ THE `never` BRANCH BELOW GUARDS THIS CLIENT-LOCAL UNION ONLY — it is not a
 * cross-boundary check, and saying "exhaustive" without that qualifier overstates
 * it. This type is a hand-mirror and `data` is an `as`-cast of a wire payload, so
 * widening the union SERVER-side does not fail `tsc` here: the default branch is
 * reached at runtime and returns the raw reason string, which would render an
 * unrecognised reason as body text. It does catch the case it can catch — someone
 * widening THIS union without adding copy — which is why it stays.
 */
type GoodsUnavailableReason = 'unreadable';

function goodsUnavailableMessage(reason: GoodsUnavailableReason): string {
  switch (reason) {
    case 'unreadable':
      return 'Digital goods sales could not be loaded, so none are shown here. This is not a report of zero sales — the figures above cover your other revenue only.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * Mirrors `GoodsSalesSummary` in
 * `~/server/services/blocks/buzz-attribution.service` — redeclared for the same
 * reason the union above is: that module is not client-safe.
 *
 * 🔴 BUZZ FIRST, USD SECOND, and this is NOT cosmetic. 1,000 Buzz = $1, so a
 * cent is 10 Buzz and the minimum priced good is 2 Buzz — a 10-Buzz good pays its
 * owner 7 Buzz, which floors to **0 cents**. Rendering this rail in dollars alone
 * shows `$0.00` next to a sale that happened, which is the invisible-revenue bug
 * one layer down. Hence the Buzz headline and `approxDollars()` for the aside.
 */
type GoodsShape = {
  sales: {
    count: number;
    grossBuzz: number;
    shareBuzz: number;
    shareUsdCents: number;
    grossUsdCents: number;
    /** Gross Buzz paid from buyers' BLUE balances — drives the non-bankable caveat. */
    blueGrossBuzz: number;
  };
  refunded: { count: number; grossBuzz: number };
  unavailable?: GoodsUnavailableReason;
};

type RevenueData = {
  summary: SummaryShape;
  topApps: Array<{ appBlockId: string; shareCents: number; count: number }>;
  recentAttributions: RecentRow[];
  /**
   * REQUIRED in the type, because an optional field invites a renderer to skip it
   * and skipping it is the defect being fixed — goods revenue that exists and is
   * shown nowhere. The server returns it on both paths (`getMyRevenue` measures
   * it, `emptyRevenue()` zeroes it).
   *
   * ⚠️ BUT THE TYPE IS NOT A GUARANTEE, and the first version of this docblock
   * claimed it was: it argued "client and server ship in one bundle, so there is
   * no skew that could make it absent". That is false here. `rawData` arrives over
   * the wire and is `as`-cast below, so nothing checks it — and on this deployment
   * SSR and `/api/trpc` are SEPARATE deployments with independent rollouts, so a
   * browser holding the new bundle can be answered by an older API process during
   * any rollout window. Destructuring `goods` unchecked then threw and took the
   * WHOLE revenue page down, which is the same outage the `unreadable` branch was
   * added to prevent, reached by a different route.
   *
   * The reader therefore defaults it — see `GOODS_ABSENT` — to the unreadable
   * shape rather than to zeros, because "the payload did not carry this" is
   * exactly "could not be read", and reporting it as zero sales would be the
   * fabricated zero again.
   */
  goods: GoodsShape;
  /**
   * Set by the server ONLY when the zeroed buckets were never measured (the
   * dark `appBlocks` flag). Absent on a real measurement, including a genuine
   * all-zero one.
   */
  unavailable?: RevenueUnavailableReason;
};

/**
 * The fallback when the payload carries no `goods` key at all — a response from an
 * API process older than this bundle. Mirrors `unreadableGoodsSales()` on the
 * server: zeros PLUS the discriminator, never bare zeros, because "absent from the
 * payload" and "could not be read" are the same fact from the reader's side and
 * neither is a measurement of zero sales.
 */
const GOODS_ABSENT: GoodsShape = {
  sales: {
    count: 0,
    grossBuzz: 0,
    shareBuzz: 0,
    shareUsdCents: 0,
    grossUsdCents: 0,
    blueGrossBuzz: 0,
  },
  refunded: { count: 0, grossBuzz: 0 },
  unavailable: 'unreadable',
};

function dollars(cents: number | null | undefined) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

/**
 * The USD aside on a Buzz figure.
 *
 * 🔴 A NON-ZERO BUZZ AMOUNT MUST NEVER RENDER AS `$0.00`. The server floors
 * Buzz→cents (deliberately, so it never over-states), and every owner share under
 * 10 Buzz floors to zero — which on a money page reads as "you earned nothing"
 * beside a row that says otherwise. `<$0.01` is the honest form: it says the
 * amount is real and smaller than the unit can express.
 *
 * 🔴 BOTH HALVES OF THE CONDITION ARE GUARDED BY TESTS, because dropping either
 * one is a lie in a different direction: without `buzzAmount > 0` a true zero
 * renders `<$0.01` and claims an earning that does not exist; without
 * `cents === 0` a real cent amount is hidden behind the sub-cent form. The paid
 * case pins `<$0.01`, the refunded case pins `$0.00`.
 *
 * No `≈` on the sub-cent form — "approximately less than a cent" is not what is
 * meant, and `<$0.01` is already exact as an upper bound.
 */
function approxDollars(cents: number, buzzAmount: number) {
  if (cents === 0 && buzzAmount > 0) return '<$0.01';
  return `≈ ${dollars(cents)}`;
}

function SummaryCards({ summary }: { summary: SummaryShape }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
      <Card padding="md" radius="md" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Pending
          </Text>
          <Tooltip label="Settles after the refund window (Stripe: 30 days)" position="top">
            <IconInfoCircle size={14} />
          </Tooltip>
        </Group>
        <Title order={3} mt={4}>
          {dollars(summary.pending.shareCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.pending.count} purchase{summary.pending.count === 1 ? '' : 's'}
        </Text>
      </Card>
      <Card padding="md" radius="md" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Confirmed (unpaid)
          </Text>
          <Tooltip
            label="Past the refund window. This amount accrues; automated payouts are not yet enabled."
            position="top"
          >
            <IconInfoCircle size={14} />
          </Tooltip>
        </Group>
        <Title order={3} mt={4} c="green">
          {dollars(summary.confirmed.shareCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.confirmed.count} purchase{summary.confirmed.count === 1 ? '' : 's'}
        </Text>
      </Card>
      <Card padding="md" radius="md" withBorder>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          Paid out
        </Text>
        <Title order={3} mt={4}>
          {dollars(summary.paidOut.shareCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.paidOut.count} purchase{summary.paidOut.count === 1 ? '' : 's'}
        </Text>
      </Card>
      <Card padding="md" radius="md" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Voided
          </Text>
          <Tooltip label="Refunds, chargebacks, and self-purchases. Not paid out." position="top">
            <IconInfoCircle size={14} />
          </Tooltip>
        </Group>
        <Title order={3} mt={4} c="dimmed">
          {dollars(summary.voided.grossCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.voided.count} purchase{summary.voided.count === 1 ? '' : 's'}
        </Text>
      </Card>
    </SimpleGrid>
  );
}

/**
 * Digital-goods sales — the second revenue rail, and the whole point of this
 * card existing separately.
 *
 * 🔴 ITS OWN LINE, NOT FOLDED INTO THE BUCKETS ABOVE, for three reasons that each
 * rule out folding on their own:
 *   - UNITS. Those buckets are USD cents; this rail is whole Buzz, and cents
 *     cannot represent a 7-Buzz share. Adding them would either round this rail
 *     to zero or silently redenominate theirs.
 *   - LIFECYCLE. `pending → confirmed → paid_out` is the card-purchase refund
 *     window. A goods sale has no such window: the owner is credited in the same
 *     request. There is no bucket above that a sale honestly belongs in.
 *   - PROVENANCE. These figures come from `block_good_purchase`, not from
 *     `BlockBuzzAttribution`. Merging the totals would make the two
 *     indistinguishable in a dispute.
 *
 * 🔴 RENDERED EVEN WHEN EVERY FIGURE IS ZERO. Hiding the card on no-sales would
 * make "this app sold nothing" indistinguishable from "this surface does not
 * report sales" — which is the bug this whole component already guards against
 * one level up, in the `unavailable` discriminator. A measured zero is
 * information; a missing card is not.
 */
/**
 * 🔴 THIS SENTENCE DESCRIBES THE RAIL'S TIMING AND DELIBERATELY DOES NOT PROMISE
 * THAT ANY PARTICULAR SALE'S BUZZ ARRIVED.
 *
 * An earlier draft read "Your share **is credited** in Buzz at the time of each
 * sale", which the figure beside it cannot support: `shareBuzz` sums
 * `app_owner_share_buzz`, the recorded obligation, and `payBlockGoodOwner` can
 * exhaust its retries and leave the row `paid` with `payouts` short of that total
 * — with no re-runner. The service docblock warns in those words against
 * relabelling the figure "received"; the copy then did exactly that, on the one
 * surface whose own test file exists because three committed claims once described
 * a payout pipeline that did not run.
 *
 * "pays out … rather than accruing" is a claim about the MECHANISM, which is true
 * and guarded: `payout-copy-truthfulness.test.ts` asserts the payout leg is
 * actually called. "is your recorded share" is a claim about the FIGURE, which is
 * exactly what the column is.
 */
const GOODS_TIMING_TOOLTIP =
  'This rail pays out immediately in Buzz rather than accruing like the buckets above. The figure is your recorded share of each settled sale. Reversed, refunded and not-yet-settled rows are all excluded.';

/**
 * 🔴 BLUE BUZZ IS NOT CASH, so a dollar figure beside it needs saying so.
 * `blue_paid_buzz` exists precisely to stop a viewer paying blue from turning
 * non-withdrawable Buzz into withdrawable earnings, and the owner's share is paid
 * proportionally in blue. Whenever any gross blue is present the USD asides are an
 * upper bound on what could ever be cashed, not a value. Worded around the GROSS
 * blue total because that is all the aggregate can know — see `blueGrossBuzz`.
 *
 * 🔴 "MAY BE", NOT "IS" — a correction, not a hedge. `blueLegOfPayout` FLOORS:
 * `floor(share * bluePaid / price)`. At the 70% share a sale with exactly 1 blue
 * Buzz gives `floor(0.7) = 0`, so gross blue is non-zero while the owner's share is
 * paid entirely in the domain colour. The aggregate sums over every paid row, so ONE
 * such historical sale would otherwise assert indefinitely that part of the owner's
 * share is non-bankable when none of it is.
 *
 * The other direction needs no hedge: `blueGrossBuzz === 0` means every row had
 * `bluePaid === 0`, so every blue leg is 0 — a partly-blue share with zero gross blue
 * is impossible, and the caveat cannot be falsely SILENT.
 */
const GOODS_BLUE_CAVEAT =
  'Some of these sales were paid with Blue Buzz, so part of your share may be Blue and cannot be withdrawn. The dollar figures are an upper bound.';

function GoodsSalesCard({ goods, scoped }: { goods: GoodsShape; scoped: boolean }) {
  const { sales, refunded, unavailable } = goods;
  return (
    <Card padding="md" radius="md" withBorder>
      <Group gap="xs">
        <Title order={5}>Digital goods sales</Title>
        <Tooltip label={GOODS_TIMING_TOOLTIP} position="top" multiline w={320}>
          <IconInfoCircle size={14} />
        </Tooltip>
      </Group>

      {unavailable ? (
        // 🔴 FIRST BRANCH, so a flagged bucket can never fall through to the stat
        // grid and render its zeros as a measurement. Same contract as the
        // payload-level guard one level up: zeros that were never measured must be
        // labelled, not shown.
        <Text c="yellow" size="sm" mt="sm" data-testid="goods-unavailable">
          {goodsUnavailableMessage(unavailable)}
        </Text>
      ) : sales.count === 0 && refunded.count === 0 ? (
        // 🔴 BOTH TERMS. "Nothing sold" is only true when there is also nothing
        // reversed — a good that WAS bought and then reversed makes that sentence
        // false, and the honest render is the stat grid at zero plus the line
        // below saying why the total is nothing.
        //
        // 🔴 AND THE WORDING IS ABOUT WHAT WAS MEASURED, NOT ABOUT THE APP. The
        // aggregate is scoped by `app_owner_user_id`, so "no digital goods sold
        // through this app" is a claim it never made: an accepted COLLABORATOR can
        // reach the per-app revenue page (it admits anything in `getMyApps`, which
        // includes seated apps) and none of the owner's rows are attributed to
        // them, so they would be shown that sentence for an app that has sales.
        // "attributed to you" is the hedge the attribution rail's own copy uses,
        // and it is true for owner and editor alike.
        <Text c="dimmed" size="sm" mt="sm">
          {scoped
            ? 'No digital goods sales attributed to you for this app yet.'
            : 'No digital goods sales attributed to you on your apps yet.'}
        </Text>
      ) : (
        // Each money figure carries a testid, and so does its enclosing tile. The
        // Buzz amounts are small integers, and `toHaveTextContent` is a SUBSTRING
        // match, so `getByText('7')` cannot say which field it found and
        // `toHaveTextContent('0')` is satisfied by "10". The per-figure testids
        // let a test anchor the number; the per-tile testids let it anchor the
        // number to its LABEL, which is what catches the two labels being swapped.
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" mt="sm">
          <div data-testid="goods-sales-tile">
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              Sales
            </Text>
            <Title order={3} mt={4} data-testid="goods-sales-count">
              {sales.count.toLocaleString()}
            </Title>
          </div>
          <div data-testid="goods-gross-tile">
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              Gross
            </Text>
            <Group gap={4} mt={4}>
              <IconBolt size={18} />
              <Title order={3} data-testid="goods-gross-buzz">
                {sales.grossBuzz.toLocaleString()}
              </Title>
            </Group>
            <Text size="xs" c="dimmed" data-testid="goods-gross-usd">
              {approxDollars(sales.grossUsdCents, sales.grossBuzz)}
            </Text>
          </div>
          <div data-testid="goods-share-tile">
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              Your share
            </Text>
            <Group gap={4} mt={4}>
              <IconBolt size={18} />
              <Title order={3} c="green" data-testid="goods-share-buzz">
                {sales.shareBuzz.toLocaleString()}
              </Title>
            </Group>
            <Text size="xs" c="dimmed" data-testid="goods-share-usd">
              {approxDollars(sales.shareUsdCents, sales.shareBuzz)}
            </Text>
          </div>
        </SimpleGrid>
      )}

      {!unavailable && sales.blueGrossBuzz > 0 && (
        <Text size="xs" c="dimmed" mt="sm" data-testid="goods-blue-caveat">
          {GOODS_BLUE_CAVEAT}
        </Text>
      )}

      {!unavailable && refunded.count > 0 && (
        // Shown so the exclusion is visible rather than silent — an owner whose
        // total dropped should be able to see why.
        //
        // 🔴 "REVERSED OR REFUNDED", NOT "REFUNDED SALES". `status='refunded'`
        // covers two shapes the column cannot separate: a sale that was owned and
        // then refunded, and a charge reversed before any entitlement was granted
        // — `voidReversedClaim` stamps it onto a `pending` row whose debit failed,
        // where NO SALE EVER HAPPENED. The discriminator is whether an entitlement
        // points at the row, and this aggregate does not join it, so calling these
        // "refunded sales" would tell an owner they lost revenue to buyers who
        // changed their mind when the likelier cause early on is a failed charge.
        //
        // 🔴 NO SHARE FIGURE, and for a narrower reason than it looks: a refund
        // normally claws the owner's payout back, but `refundBlockGoodPurchase`
        // records failed clawback legs in `failures` and marks the row `refunded`
        // regardless — so in that case the owner did keep some of it. A share here
        // would be a claim this aggregate cannot support in either direction.
        <Text size="xs" c="dimmed" mt="sm" data-testid="goods-reversed-line">
          {refunded.count.toLocaleString()} reversed or refunded
          {refunded.count === 1 ? ' charge' : ' charges'} ({refunded.grossBuzz.toLocaleString()}{' '}
          Buzz) — not counted above.
        </Text>
      )}
    </Card>
  );
}

/**
 * Publisher revenue dashboard for `blocks.getMyRevenue`.
 *
 * Pass `appBlockId` to scope to a single app (the /apps/[appBlockId]/revenue
 * page); omit it entirely for the caller's whole portfolio (/apps/revenue).
 * Both pages render THIS component so the fabricated-zero guard below exists in
 * exactly one place — it previously lived in neither, duplicated across two
 * page-local copies of this markup.
 *
 * The guard: `getMyRevenue` returns all-zero buckets both for a publisher who
 * has genuinely earned nothing yet and for a caller the dark `appBlocks` flag
 * never let it query. Only `unavailable` separates them, so presenting the
 * zeroed dashboard for the latter reports fabricated earnings as fact.
 *
 * ⚠️ TWO RAILS, AND `topApps` ONLY RANKS ONE. `SummaryCards` + `topApps` +
 * "Recent attributions" are the card-purchase rail (`BlockBuzzAttribution`, USD
 * cents); `GoodsSalesCard` is the digital-goods rail (`block_good_purchase`,
 * whole Buzz). The ranking is deliberately NOT merged: the two are denominated
 * differently, so one ordering over both would be comparing cents to Buzz. An
 * owner whose only revenue is sales therefore sees a populated goods card and an
 * absent "Top earning apps" — correct, if initially surprising. A unified
 * ranking needs a decision about which unit it is in; this change does not make
 * one.
 */
export function RevenuePanel({ appBlockId }: { appBlockId?: string }) {
  // `appBlockId === undefined` means "all my apps"; an explicitly-passed empty
  // string means the caller's route param has not resolved yet — don't query.
  const scoped = appBlockId !== undefined;
  const {
    data: rawData,
    isLoading,
    error,
  } = trpc.blocks.getMyRevenue.useQuery(scoped ? { appBlockId } : {}, {
    enabled: !scoped || !!appBlockId,
  });
  const data = rawData as RevenueData | undefined;
  const unavailable = data?.unavailable;

  return (
    <Stack gap="lg">
      {isLoading && (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      )}
      {error && (
        <Text c="red" size="sm">
          Failed to load revenue: {error.message}
        </Text>
      )}

      {unavailable && (
        <Alert
          variant="light"
          color="yellow"
          icon={<IconInfoCircle size={16} />}
          title="Revenue unavailable"
        >
          <Text size="sm">{unavailableMessage(unavailable)}</Text>
        </Alert>
      )}

      {data && !unavailable && (
        <>
          <SummaryCards summary={data.summary} />

          {/*
            `?? GOODS_ABSENT` rather than `data.goods` alone: the type says this key is
            required, but `data` is an `as`-cast of a wire payload, and SSR and the API
            are separate deployments here — so an older API process can answer this
            bundle during a rollout and omit it. Destructuring it unchecked threw and
            took the whole page down. The fallback is the UNREADABLE shape, not zeros.
          */}
          <GoodsSalesCard goods={data.goods ?? GOODS_ABSENT} scoped={scoped} />

          {!scoped && data.topApps.length > 0 && (
            <Card padding="md" radius="md" withBorder>
              <Title order={5}>Top earning apps</Title>
              <Stack gap="xs" mt="sm">
                {data.topApps.map((app) => (
                  <Group key={app.appBlockId} justify="space-between">
                    <Anchor component={Link} href={`/apps/${app.appBlockId}/revenue`} size="sm">
                      {app.appBlockId}
                    </Anchor>
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        {dollars(app.shareCents)}
                      </Text>
                      <Badge variant="light" size="sm">
                        {app.count}
                      </Badge>
                    </Group>
                  </Group>
                ))}
              </Stack>
            </Card>
          )}

          <Card padding="md" radius="md" withBorder>
            <Title order={5}>Recent attributions</Title>
            {data.recentAttributions.length === 0 ? (
              <Text c="dimmed" size="sm" mt="sm">
                {scoped
                  ? 'No buzz purchases attributed to this app yet.'
                  : 'No buzz purchases yet. Install your apps on more models to earn share.'}
              </Text>
            ) : (
              <Table mt="sm" highlightOnHover>
                {/*
                  🔴 FIRST CHILD, BEFORE the row groups — HTML requires it there; the
                  ordering is pinned by `~/components/Apps/__tests__/appsWideLayout.test.ts`.
                  The ledger is chosen by `scoped`, the SAME flag that
                  decides whether the App column renders, so the column count and the width
                  list cannot drift apart. Unscoped (`/apps/revenue`, full container) the
                  App link is primary; scoped there is no App column and Scope takes the
                  slack.
                */}
                <AppsTableColgroup
                  columns={scoped ? APPS_REVENUE_COLUMNS.scoped : APPS_REVENUE_COLUMNS.withApp}
                />
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    {!scoped && <Table.Th>App</Table.Th>}
                    <Table.Th>Scope</Table.Th>
                    <Table.Th>
                      <Group gap={4}>
                        <IconBolt size={14} />
                        Buzz
                      </Group>
                    </Table.Th>
                    <Table.Th>Gross</Table.Th>
                    <Table.Th>Your share</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.recentAttributions.map((row: RecentRow) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>{new Date(row.attributedAt).toLocaleDateString()}</Table.Td>
                      {!scoped && (
                        <Table.Td>
                          <Anchor
                            component={Link}
                            href={`/apps/${row.appBlockId}/revenue`}
                            size="sm"
                          >
                            {row.appBlockId}
                          </Anchor>
                        </Table.Td>
                      )}
                      <Table.Td>{row.scope}</Table.Td>
                      <Table.Td>{row.buzzAmount.toLocaleString()}</Table.Td>
                      <Table.Td>{dollars(row.usdAmountCents)}</Table.Td>
                      <Table.Td>{dollars(row.appOwnerShareCents)}</Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={
                            row.status === 'paid_out'
                              ? 'green'
                              : row.status === 'confirmed'
                              ? 'teal'
                              : row.status === 'voided'
                              ? 'red'
                              : 'gray'
                          }
                          size="sm"
                        >
                          {row.status}
                          {row.voidedReason ? ` (${row.voidedReason})` : ''}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </Stack>
  );
}
