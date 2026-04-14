import { Anchor, Button, Center, Loader, Modal, Table } from '@mantine/core';
import { capitalize } from 'lodash-es';
import { useBankedBuzz } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  CAP_DEFINITIONS,
  EXTRACTION_FEES,
  MIN_CAP,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import { getCapForDefinition, getNextCapDefinition } from '~/shared/utils/creator-program.utils';
import type { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import {
  abbreviateNumber,
  formatCurrencyForDisplay,
  numberWithCommas,
} from '~/utils/number-helpers';
import { getDisplayName, toPascalCase } from '~/utils/string-helpers';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzBankTypes } from '~/shared/constants/buzz.constants';

export const openPhasesModal = (buzztype: BuzzSpendType) => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Creator Program Phases',
      type: 'info',
      icon: null,
      size: 'lg',
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-4">
          <p>Every month, the Creator Program runs in two phases:</p>

          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-bold">Banking Phase</h3>
            <ul className="pl-4">
              <li>
                During this phase, creators can Bank any {toPascalCase(buzztype ?? 'Yellow')} Buzz
                they&rsquo;ve earned.
              </li>
              <li>This phase lasts until 3 days before the end of the month (UTC).</li>
              <li>
                As the month progresses, the value of your Banked Buzz{' '}
                <span className="font-bold underline">decreases</span> because the total amount of
                Buzz in the Bank increases.
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-bold">Extraction Phase</h3>
            <ul className="pl-4">
              <li>During this phase, Banking Buzz is disabled.</li>
              <li>
                Creators can review their share of the Compensation Pool and decide whether to keep
                their Buzz Banked or extract it.
              </li>
              <li>
                Extraction is all or nothing, and a fee applies to any amount over 100k Buzz to
                prevent Bank manipulation.
              </li>
              <li>Extracted Buzz can be saved for a future month or used on Civitai.</li>
              <li>
                This phase starts 3 days before the end of the month and ends 1 hour before the
                month ends (UTC).
              </li>
              <li>
                As more creators extract their Buzz, the value of your Banked Buzz{' '}
                <span className="font-bold underline">increases</span>, making your share of the
                Pool bigger!
              </li>
            </ul>
          </div>
          <Button onClick={handleClose}>Close</Button>
        </div>
      ),
    },
  });
};
export const openEarningEstimateModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'How does this work?',
      type: 'info',
      icon: null,
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-4">
          <p>
            This is an estimated value based on the assumption that a portion of all Buzz earned by
            creators will be Banked. The amount you receive depends on the total Buzz Banked by all
            creators at the end of the month. If you&rsquo;re not happy with your estimated payout,
            you can withdraw your Buzz during the 3-day Extraction Phase at the end of the month.
          </p>
          <Button onClick={handleClose}>Close</Button>
        </div>
      ),
    },
  });
};

export const openSettlementModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'What is Pending Settlement?',
      type: 'info',
      icon: null,
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-4">
          <p>
            Once you&rsquo;ve received your share of the Compensation Pool, we need 15 days to
            review the distribution. At 12am UTC on the 15th of the month your Pending Settlement
            earnings will become Ready to Withdraw.
          </p>
          <Button onClick={handleClose}>Close</Button>
        </div>
      ),
    },
  });
};

export const openWithdrawalFeeModal = () => {
  const keys = Object.keys(WITHDRAWAL_FEES) as CashWithdrawalMethod[];
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Withdrawal Fees',
      type: 'info',
      icon: null,
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-1">
          <p className="mb-2">
            Withdrawal fees vary depending on the Withdrawal Method you choose.
          </p>
          {keys.map((key) => {
            const withdrawalFees = WITHDRAWAL_FEES[key];
            if (!withdrawalFees) {
              return null;
            }

            return (
              <div className="flex gap-4" key={key}>
                <p className="font-bold">{getDisplayName(key)}</p>
                <p>
                  {withdrawalFees.type === 'percent'
                    ? `${withdrawalFees.amount * 100}%`
                    : `$${formatCurrencyForDisplay(withdrawalFees.amount, Currency.USD)}`}
                </p>
              </div>
            );
          })}

          <Button className="mt-2" onClick={handleClose}>
            Close
          </Button>
        </div>
      ),
    },
  });
};

export const openCompensationPoolModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Compensation Pool',
      type: 'info',
      icon: null,
      children: ({ handleClose }) => (
        <div className="flex flex-col justify-center gap-4">
          <p>
            The Creator Program Compensation Pool is made up of a portion of Civitai&rsquo;s revenue
            from the previous month. As Civitai grows, so does the pool! The more active Creators
            there are attracting users who spend Buzz, the larger the pool will be the next month
          </p>
          <Button onClick={handleClose}>Close</Button>
        </div>
      ),
    },
  });
};

export const openExtractionFeeModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Extraction Fees',
      type: 'info',
      icon: null,
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-1">
          <p className="mb-2">
            Extraction is all or nothing. You can&rsquo;t Extract just a portion of what you have
            Banked.
          </p>
          <p className="mb-2">
            To prevent manipulation of the total Banked amount by Creators with large amounts of
            Buzz, we&rsquo;ve implemented the following Extraction Fees:
          </p>
          <ul className="py-2 pl-4">
            {EXTRACTION_FEES.map((fee) => {
              const feeCopy = fee.fee > 0 ? `${fee.fee * 100}% Fee` : 'No Fee';

              return (
                <li key={fee.max}>
                  <span className="font-bold">
                    {fee.min === 0
                      ? `<  ${abbreviateNumber(fee.max ?? 0)} Buzz`
                      : `${abbreviateNumber(fee.min)}${
                          fee.max ? ` - ${abbreviateNumber(fee.max)}` : '+'
                        } Buzz`}
                    :
                  </span>{' '}
                  {feeCopy}
                </li>
              );
            })}
          </ul>

          <p>
            The fees work on a bracket-based system, meaning that your first 100k Buzz Extracted is
            free, your next 900k carries a 5% fee and so on.
          </p>
          <Button className="mt-2" onClick={handleClose}>
            Close
          </Button>
        </div>
      ),
    },
  });
};

export const openCreatorScoreModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'What is your Creator Score?',
      type: 'info',
      icon: null,
      children: ({ handleClose }) => (
        <div className="flex flex-col justify-center gap-4">
          <p>
            Creator Score is a value we calculate based on your participation in the Civitai
            community, including your activity and how others engage with the content and models you
            create.
          </p>
          <Button className="mt-2" onClick={handleClose}>
            Close
          </Button>
        </div>
      ),
    },
  });
};

export const CreatorProgramCapsInfo = ({ onUpgrade }: { onUpgrade?: () => void }) => {
  const [activeBuzzType] = useAvailableBuzz();
  const { banked, isLoading } = useBankedBuzz(activeBuzzType);

  if (isLoading) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  const peakEarned = banked?.cap?.peakEarning?.earned ?? 0;
  const currentCap = banked?.cap?.cap ?? 0;

  const nextCap = banked?.cap
    ? getNextCapDefinition(banked.cap.definition.tier, currentCap, peakEarned)
    : undefined;

  const potentialEarnings = nextCap && getCapForDefinition(nextCap, peakEarned);

  return (
    <div className="flex flex-col gap-4">
      <p>
        Every creator in the program has a Cap to the amount of Buzz they can Bank in a month. Caps
        align with membership tiers as outlined below.
      </p>

      <Table className="table-auto">
        <Table.Thead>
          <Table.Tr className="text-left">
            <Table.Th>Tier</Table.Th>
            <Table.Th>Cap</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {CAP_DEFINITIONS.map((cap) => {
            if (cap.hidden) {
              return null;
            }

            return (
              <Table.Tr key={cap.tier}>
                <Table.Td className="font-bold">{capitalize(cap.tier)} Member</Table.Td>
                <Table.Td>
                  <p className="flex gap-1">
                    {cap.percentOfPeakEarning
                      ? `${cap.percentOfPeakEarning * 100}% of your Peak Earning Month with `
                      : ''}

                    {!cap.limit ? (
                      'no cap'
                    ) : cap.percentOfPeakEarning ? (
                      <span className="inline-flex">
                        a{' '}
                        <CurrencyIcon
                          currency={Currency.BUZZ}
                          type={activeBuzzType}
                          className="inline"
                        />
                        {abbreviateNumber(cap.limit)} cap
                      </span>
                    ) : (
                      <span className="inline-flex">
                        <CurrencyIcon
                          currency={Currency.BUZZ}
                          type={activeBuzzType}
                          className="inline"
                        />
                        {abbreviateNumber(cap.limit)}
                      </span>
                    )}
                  </p>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      {banked && banked?.cap && (
        <>
          <div className="flex flex-col">
            <p>
              <span className="font-bold">Tier:</span> {capitalize(banked.cap.definition.tier)}{' '}
              Member
            </p>
            <p>
              <span className="font-bold">Peak Earning Month:</span>{' '}
              <CurrencyIcon currency={Currency.BUZZ} type={activeBuzzType} className="inline" />
              {abbreviateNumber(banked.cap.peakEarning.earned)}{' '}
              <span className="opacity-50">
                ({formatDate(banked.cap.peakEarning.month, 'MMM YYYY')})
              </span>
            </p>
            <p>
              <span className="font-bold">Tier Cap:</span>{' '}
              <CurrencyIcon currency={Currency.BUZZ} type={activeBuzzType} className="inline" />
              {banked.cap.definition.limit
                ? numberWithCommas(banked.cap.definition.limit)
                : 'No Cap'}
            </p>
            <p className="font-bold">
              Your Cap:{' '}
              <CurrencyIcon currency={Currency.BUZZ} type={activeBuzzType} className="inline" />{' '}
              {numberWithCommas(Math.floor(banked.cap.cap))}
            </p>

            {banked.cap.cap <= MIN_CAP && (
              <p className="text-sm opacity-50">
                All members have a minimum cap of{' '}
                <CurrencyIcon currency={Currency.BUZZ} type={activeBuzzType} className="inline" />{' '}
                {abbreviateNumber(MIN_CAP)}
              </p>
            )}
          </div>

          {nextCap && (
            <p>
              You could increase your cap to{' '}
              <CurrencyIcon currency={Currency.BUZZ} type={activeBuzzType} className="inline" />{' '}
              {numberWithCommas(Math.floor(potentialEarnings as number))} by upgrading to a{' '}
              {capitalize(nextCap.tier)} Membership.{' '}
              <Anchor className="text-nowrap" href="/pricing" onClick={onUpgrade}>
                Upgrade Now
              </Anchor>
            </p>
          )}
        </>
      )}
    </div>
  );
};

export const CreatorProgramCapsInfoModal = () => {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} size="lg" radius="md" withCloseButton={false}>
      <p className="text-center text-lg font-bold">Creator Banking Caps</p>
      <CreatorProgramCapsInfo onUpgrade={dialog.onClose} />
      <Button onClick={dialog.onClose}>Close</Button>
    </Modal>
  );
};
