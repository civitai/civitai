import { Modal, ThemeIcon } from '@mantine/core';
import { IconFlame, IconHammer, IconMoneybag } from '@tabler/icons-react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';

export function NewOrderRulesModal({ opened, onClose, footer }: Props) {
  return (
    <Modal
      size="lg"
      onClose={onClose}
      opened={opened}
      title={<h1 className="text-xl font-semibold text-orange-5">What is Knights of New Order?</h1>}
      centered
    >
      <div className="flex flex-col gap-4">
        <p>
          Knights of New Order is a thrilling game where players take on the roles of knights in
          order to apply ratings to content shared by the community, ensuring that content has the
          correct ratings. Players progress through the ranks of the Order, moderating content while
          earning rewards.
        </p>
        <h2 className="text-lg font-semibold text-orange-5">Ranks of the New Order</h2>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Acolyte (Training Rank)</h3>
          <p>
            All players start as an <span className="font-semibold">Acolyte</span>, training in the
            art of content judgment. As an Acolyte, you will learn the basics of the game and gain
            experience by rating images to level up.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Knight (Blessed Rank)</h3>
          <p>
            Upon reaching Level 30, Acolytes are ordained as{' '}
            <span className="font-semibold">Knights</span> and may earn{' '}
            <span className="font-semibold">Gold</span> by each rating they give, or get{' '}
            <span className="font-semibold">Smites</span> if the given rating does not align with
            the consensus of the Order.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Templar (Elite Rank)</h3>
          <p>
            Each week, 12 Knights with the highest <span className="font-semibold">Fervor</span> are
            chosen as <span className="font-semibold">Templars</span>, serving as the final arbiters
            before judgment reaches the <span className="font-semibold">Inquisitors</span>. Templars
            review disputed cases where Knights fail to reach a consensus.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Inquisitor (Final Authority)</h3>
          <p>
            These are the current site moderators, serving as the final decision-makers in the
            Order. While not a player rank at this time, perhaps one day the most devoted Templars
            may earn the right to stand among them.
          </p>
        </div>
        <h2 className="text-lg font-semibold text-orange-5">Mechanics</h2>
        <p>
          The following only applies once players reach{' '}
          <span className="font-semibold">Knight</span> or{' '}
          <span className="font-semibold">Templar</span> rank.
        </p>
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 font-semibold">
            <ThemeIcon color="yellow">
              <IconMoneybag stroke={1.5} size={18} />
            </ThemeIcon>{' '}
            <span>Gold</span>
          </h3>
          <p>
            Players earn <span className="font-semibold">Gold</span> by rating images.
          </p>
          <ul className="pl-8">
            <li>
              Gold must pass a 3-day settlement period before it can be converted into{' '}
              <span className="flex items-center gap-1">
                <CurrencyIcon size={16} currency="BUZZ" /> Buzz.
              </span>
            </li>
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 font-semibold">
            <ThemeIcon color="orange">
              <IconFlame size={18} stroke={1.5} />
            </ThemeIcon>{' '}
            Fervor
          </h3>
          <p>
            Players earn <span className="font-semibold">Fervor</span> by the accuracy of correct
            judgment they make.
          </p>
          <ul className="pl-8">
            <li>
              Fervor is used to determine the top 12 Knights of the week, who are then promoted to
              Templar.
            </li>
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">
            <ThemeIcon color="red">
              <IconHammer stroke={1.5} size={18} />
            </ThemeIcon>{' '}
            Smites
          </h3>
          <p>
            Players may receive <span className="font-semibold">Smites</span> if their rating
            decision is deemed gravely inaccurate by an{' '}
            <span className="font-semibold">Inquisitor</span>.
          </p>
          <ul className="pl-8">
            <li>
              These can be cleansed by rating images correctly, automatically after 7 days of
              service or by intervention from a Inquisitor
            </li>
            <li className="font-semibold">
              Receiving 3 smites results in demotion back to level 1
            </li>
          </ul>
        </div>
        <h2 className="text-lg font-semibold text-orange-5">Join the Order</h2>
        <p>
          Join us now and experience the excitement of Knights of New Order. Will you rise to the
          challenge and become a legendary knight?
        </p>
        {footer}
      </div>
    </Modal>
  );
}

type Props = { opened: boolean; onClose: VoidFunction; footer?: React.ReactNode };
