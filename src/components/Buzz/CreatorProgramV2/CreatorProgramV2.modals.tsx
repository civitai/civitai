import { Button } from '@mantine/core';
import { capitalize } from 'lodash-es';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { WITHDRAWAL_FEES } from '~/shared/constants/creator-program.constants';
import { CashWithdrawalMethod, Currency } from '~/shared/utils/prisma/enums';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';

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
              <li>During this phase, creators can bank any Yellow Buzz they&rsquo;ve earned.</li>
              <li>This phase lasts until 3 days before the end of the month (UTC).</li>
              <li>
                As the month progresses, the value of your banked Buzz{' '}
                <span className="font-bold">decrease</span> because the total amount of Buzz in the
                bank increases.
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-bold">Extraction Phase</h3>
            <ul className="pl-4">
              <li>During this phase, banking Buzz is disabled.</li>
              <li>
                Creators can review their share of the Compensation Pool and decide whether to keep
                their Buzz banked or extract it.
              </li>
              <li>Extracted Buzz can be saved for a future month or used on Civitai.</li>
              <li>
                This phase starts 3 days before the end of the month and ends 1 hour before the
                month ends (UTC).
              </li>
              <li>
                As more creators extract their Buzz, the value of your banked Buzz{' '}
                <span className="font-bold">increase</span>, making your share of the pool bigger!
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
