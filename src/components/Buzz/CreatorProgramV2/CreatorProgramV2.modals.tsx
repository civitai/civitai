import { Button } from '@mantine/core';
import { capitalize } from 'lodash-es';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EXTRACTION_FEES, WITHDRAWAL_FEES } from '~/shared/constants/creator-program.constants';
import { CashWithdrawalMethod, Currency } from '~/shared/utils/prisma/enums';
import { abbreviateNumber, formatCurrencyForDisplay } from '~/utils/number-helpers';

export const openPhasesModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Creator Program Phases',
      type: 'info',
      size: 'lg',
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-4">
          <p>Every month, the Creator Program runs in two phases:</p>

          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-bold">Banking Phase</h3>
            <ul className="pl-4">
              <li>During this phase, creators can Bank any Yellow Buzz they&rsquo;ve earned.</li>
              <li>This phase lasts until 3 days before the end of the month (UTC).</li>
              <li>
                As the month progresses, the value of your Banked Buzz{' '}
                <span className="font-bold underline">decreases</span> because the total amount of Buzz in the
                Bank increases.
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
              <li>Extracted Buzz can be saved for a future month or used on Civitai.</li>
              <li>
                This phase starts 3 days before the end of the month and ends 1 hour before the
                month ends (UTC).
              </li>
              <li>
                As more creators extract their Buzz, the value of your Banked Buzz{' '}
                <span className="font-bold underline">increases</span>, making your share of the Pool bigger!
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

export const openWithdrawalFreeModal = () => {
  const keys = Object.keys(WITHDRAWAL_FEES) as CashWithdrawalMethod[];
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Withdrawal Fees',
      type: 'info',
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-1">
          <p className="mb-2">Withdrawl fees vary depending on the Payout Method you choose.</p>
          {keys.map((key) => {
            if (!WITHDRAWAL_FEES[key]) {
              return null;
            }

            return (
              <div className="flex gap-4" key={key}>
                <p className="font-bold">{capitalize(key)}</p>
                <p>
                  {WITHDRAWAL_FEES[key].type === 'percent'
                    ? `${WITHDRAWAL_FEES[key].amount * 100}%`
                    : `$${formatCurrencyForDisplay(WITHDRAWAL_FEES[key].amount, Currency.USD)}`}
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

export const openExtractionFeeModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Extraction Fees',
      type: 'info',
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-1">
          <p className="mb-2">
            Extraction is all or nothing. You can&rsquo;t Extract just a portion of what you have
            Banked.
          </p>
          <p className="mb-2">
            To prevent manipulation of the total Banked amount by Creators with large amounts of Buzz,
            we&rsquo;ve implemented the following Extraction Fees:
          </p>
          <ul className="py-2 pl-4">
            {EXTRACTION_FEES.map((fee) => (
              <li key={fee.max}>
                {fee.min === 0
                  ? `<  ${abbreviateNumber(fee.max ?? 0)} Buzz (${
                      fee.fee > 0 ? `${fee.fee * 100}% Fee` : 'No Fee'
                    })`
                  : `${abbreviateNumber(fee.min)}${
                      fee.max ? ` - ${abbreviateNumber(fee.max)}` : '+'
                    } Buzz (${fee.fee * 100}% Fee)`}
              </li>
            ))}
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
