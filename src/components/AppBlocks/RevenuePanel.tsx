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
} from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { AppsTableColgroup, APPS_REVENUE_COLUMNS } from '~/components/Apps/appsWideLayout';
import type {
  AuthorFeeBucket,
  AuthorFeeEarnings,
} from '~/server/services/blocks/author-fee-earnings.service';
import { capitalize } from '~/utils/string-helpers';
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
  /**
   * Optional because `data` is an `as`-cast wire payload and an API process older than this
   * bundle omits it during a rollout; the card renders that as unreadable, never as zero.
   */
  authorFees?: AuthorFeeEarnings;
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
export const GOODS_ABSENT: GoodsShape = {
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

/**
 * Pinned whole by `payout-copy-truthfulness.test.ts`, together with an assertion that the daily
 * settlement job is still registered, because this sentence promises a payout cadence.
 */
const AUTHOR_FEE_PAYOUT_COPY =
  'Viewers pay your author fee when they run a generation in your app. Fees are paid into your Buzz account once a day: the fees for each day settle in a daily batch after that day ends, in the Buzz type the viewer paid with.';

const AUTHOR_FEE_PENDING_TOOLTIP =
  'Charged to viewers and not yet paid to you. If a generation fails on the same UTC day its fee was charged, the fee is refunded to the viewer and removed from this figure. After that day ends, the fee is no longer reversed.';

const AUTHOR_FEE_BLUE_CAVEAT =
  'Some of these fees were paid with Blue Buzz. You receive those as Blue Buzz, which cannot be withdrawn.';

const AUTHOR_FEES_UNAVAILABLE =
  'Author fee earnings could not be loaded, so none are shown here. This is not a report of zero earnings.';

const STATUS_LABEL: Record<string, string> = { accrued: 'Pending payout', settled: 'Paid' };

function buzzTypeBreakdown(bucket: AuthorFeeBucket) {
  return Object.entries(bucket.byBuzzType)
    .filter(([, buzz]) => buzz > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, buzz]) => `${capitalize(type)} ${buzz.toLocaleString()}`)
    .join(' · ');
}

function AuthorFeeTile({
  label,
  tooltip,
  bucket,
  testId,
  color,
}: {
  label: string;
  tooltip?: string;
  bucket: AuthorFeeBucket;
  testId: string;
  color?: string;
}) {
  const breakdown = buzzTypeBreakdown(bucket);
  return (
    <div data-testid={`${testId}-tile`}>
      <Group gap="xs">
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          {label}
        </Text>
        {tooltip && (
          <Tooltip label={tooltip} position="top" multiline w={280}>
            <IconInfoCircle size={14} />
          </Tooltip>
        )}
      </Group>
      <Group gap={4} mt={4}>
        <IconBolt size={18} />
        <Title order={3} c={color} data-testid={`${testId}-buzz`}>
          {bucket.feeBuzz.toLocaleString()}
        </Title>
      </Group>
      <Text size="xs" c="dimmed" data-testid={`${testId}-count`}>
        {bucket.count.toLocaleString()} generation{bucket.count === 1 ? '' : 's'}
        {breakdown ? ` · ${breakdown}` : ''}
      </Text>
    </div>
  );
}

export function AuthorFeeCard({
  authorFees,
  scoped,
  emptyText,
}: {
  authorFees: AuthorFeeEarnings | undefined;
  scoped: boolean;
  /** Replaces the "attributed to you" empty copy, for a surface showing a whole app's figures. */
  emptyText?: string;
}) {
  const empty = !!authorFees && authorFees.accrued.count === 0 && authorFees.settled.count === 0;
  const hasBlue =
    !!authorFees &&
    ((authorFees.accrued.byBuzzType.blue ?? 0) > 0 ||
      (authorFees.settled.byBuzzType.blue ?? 0) > 0);
  return (
    <Card padding="md" radius="md" withBorder data-testid="author-fees-card">
      <Title order={5}>Author fees</Title>
      <Text size="sm" c="dimmed" mt={4} data-testid="author-fees-payout-copy">
        {AUTHOR_FEE_PAYOUT_COPY}
      </Text>

      {!authorFees ? (
        <Text c="yellow" size="sm" mt="sm" data-testid="author-fees-unavailable">
          {AUTHOR_FEES_UNAVAILABLE}
        </Text>
      ) : empty ? (
        <Text c="dimmed" size="sm" mt="sm" data-testid="author-fees-empty">
          {emptyText ??
            (scoped
              ? 'No author fees attributed to you for this app.'
              : 'No author fees attributed to you on your apps.')}
        </Text>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="sm">
            <AuthorFeeTile
              label="Pending payout"
              tooltip={AUTHOR_FEE_PENDING_TOOLTIP}
              bucket={authorFees.accrued}
              testId="author-fees-pending"
            />
            <AuthorFeeTile
              label={
                authorFees.paidWindowDays != null
                  ? `Paid to you · last ${authorFees.paidWindowDays} days`
                  : 'Paid to you'
              }
              bucket={authorFees.settled}
              testId="author-fees-paid"
              color="green"
            />
          </SimpleGrid>
          {hasBlue && (
            <Text size="xs" c="dimmed" mt="sm" data-testid="author-fees-blue-caveat">
              {AUTHOR_FEE_BLUE_CAVEAT}
            </Text>
          )}

          {!scoped && authorFees.byApp.length > 0 && (
            <Stack gap="xs" mt="md" data-testid="author-fees-by-app">
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                By app
              </Text>
              {authorFees.byApp.map((app) => (
                <Group
                  key={app.appBlockId}
                  justify="space-between"
                  data-testid={`author-fees-app-${app.appBlockId}`}
                >
                  <Anchor component={Link} href={`/apps/${app.appBlockId}/revenue`} size="sm">
                    {app.appBlockId}
                  </Anchor>
                  <Text size="sm">
                    {app.settled.feeBuzz.toLocaleString()} paid
                    {authorFees.paidWindowDays != null
                      ? ` (last ${authorFees.paidWindowDays} days)`
                      : ''}{' '}
                    · {app.accrued.feeBuzz.toLocaleString()} pending
                  </Text>
                </Group>
              ))}
            </Stack>
          )}

          {authorFees.recent.length > 0 && (
            <>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase" mt="md">
                Recent fees
              </Text>
              <Table mt="xs" highlightOnHover data-testid="author-fees-recent">
                {/*
                  🔴 FIRST CHILD, BEFORE the row groups — the ordering is pinned by
                  `~/components/Apps/__tests__/appsWideLayout.test.ts`. The ledger is chosen by
                  `scoped`, the SAME flag that decides whether the App column renders.
                */}
                <AppsTableColgroup
                  columns={scoped ? APPS_REVENUE_COLUMNS.scoped : APPS_REVENUE_COLUMNS.withApp}
                />
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    {!scoped && <Table.Th>App</Table.Th>}
                    <Table.Th>
                      <Group gap={4}>
                        <IconBolt size={14} />
                        Fee
                      </Group>
                    </Table.Th>
                    <Table.Th>Buzz type</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {authorFees.recent.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>{new Date(row.accruedAt).toLocaleDateString()}</Table.Td>
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
                      <Table.Td>{row.feeBuzz.toLocaleString()}</Table.Td>
                      <Table.Td>{capitalize(row.buzzType)}</Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={row.status === 'settled' ? 'green' : 'gray'}
                          size="sm"
                        >
                          {STATUS_LABEL[row.status] ?? row.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </>
      )}
      {authorFees?.paidWindowDays != null && (
        <Text size="xs" c="dimmed" mt="sm" data-testid="author-fees-window">
          Last {authorFees.paidWindowDays} days: paid fees and recent fees cover only that period.
          Pending fees are shown in full.
        </Text>
      )}
    </Card>
  );
}

/**
 * Digital-goods sales — its own card, not folded into the author-fee totals: a goods
 * sale pays out in the same request while an author fee settles daily, and the two
 * come from different ledgers, so merged totals would be indistinguishable in a dispute.
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
  'This rail pays out immediately in Buzz rather than settling daily like author fees. The figure is your recorded share of each settled sale. Reversed, refunded and not-yet-settled rows are all excluded.';

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

export function GoodsSalesCard({
  goods,
  scoped,
  emptyText,
}: {
  goods: GoodsShape;
  scoped: boolean;
  /** Replaces the "attributed to you" empty copy, for a surface showing a whole app's figures. */
  emptyText?: string;
}) {
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
          {emptyText ??
            (scoped
              ? 'No digital goods sales attributed to you for this app yet.'
              : 'No digital goods sales attributed to you on your apps yet.')}
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
 * Publisher earnings dashboard for `blocks.getMyRevenue`: author fees first, then
 * digital-goods sales.
 *
 * Pass `appBlockId` to scope to a single app (the /apps/[appBlockId]/revenue
 * page); omit it entirely for the caller's whole portfolio (/apps/revenue).
 * Both pages render THIS component so the fabricated-zero guard below exists in
 * exactly one place.
 *
 * The guard: `getMyRevenue` returns all-zero buckets both for a publisher who
 * has genuinely earned nothing yet and for a caller the dark `appBlocks` flag
 * never let it query. Only `unavailable` separates them, so presenting the
 * zeroed dashboard for the latter reports fabricated earnings as fact.
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
          <AuthorFeeCard authorFees={data.authorFees} scoped={scoped} />

          {/*
            `?? GOODS_ABSENT` rather than `data.goods` alone: the type says this key is
            required, but `data` is an `as`-cast of a wire payload, and SSR and the API
            are separate deployments here — so an older API process can answer this
            bundle during a rollout and omit it. Destructuring it unchecked threw and
            took the whole page down. The fallback is the UNREADABLE shape, not zeros.
          */}
          <GoodsSalesCard goods={data.goods ?? GOODS_ABSENT} scoped={scoped} />
        </>
      )}
    </Stack>
  );
}
