import { Modal, ThemeIcon } from '@mantine/core';
import { IconFlame, IconHammer, IconMoneybag } from '@tabler/icons-react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';

export function NewOrderRulesModal({ opened, onClose, footer }: Props) {
  return (
    <Modal
      size="lg"
      onClose={onClose}
      opened={opened}
      title={<div className="text-xl font-semibold text-gold-9">What is Knights of New Order?</div>}
      centered
    >
      <div className="flex flex-col gap-4">
        <p>
          Knights of New Order is a thrilling game where players take on the roles of knights in
          order to apply ratings to content shared by the community, ensuring that content has the
          correct ratings. Players progress through the ranks of the Order, moderating content while
          earning rewards.
        </p>
        <h2 className="text-lg font-semibold text-gold-9">Ranks of the New Order</h2>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Acolyte (Training Rank)</h3>
          <p>
            All players begin as <span className="font-semibold">Acolytes</span>, training in the
            sacred art of content judgment. As an Acolyte, you&apos;ll learn the game&apos;s basics
            and gain experience by rating images to level up. But beware: five incorrect ratings at
            the same level will earn you a Smite - and three Smites will drop you all the way back
            to Level 1! The good news? Leveling up clears your Smites, so judge wisely!
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Knight (Elite Rank)</h3>
          <p>
            Upon reaching Level 20, Acolytes are ordained as{' '}
            <span className="font-semibold">Knights</span>, the elite judges of the Order. Knights
            earn <span className="font-semibold">Gold</span> for accurate ratings and work together
            to reach consensus through weighted voting. Your vote carries more weight as you gain
            experience and maintain accuracy - elite Knights at higher levels with perfect records
            have twice the voting power of new Knights!
          </p>
        </div>
        <h2 className="text-lg font-semibold text-gold-9">How Knights Rate Content</h2>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Weighted Voting System</h3>
          <p>
            Knights work together to reach consensus on image ratings. Each Knight&apos;s vote
            carries a <span className="font-semibold">weight</span> based on their level and
            accuracy:
          </p>
          <ul className="pl-8">
            <li>New Knights: 1x voting power</li>
            <li>Elite Knights: 2x voting power</li>
            <li>
              When 60% of weighted votes agree on a rating after 5 Knights vote, consensus is
              reached
            </li>
            <li>
              XP and Gold are granted immediately, but deducted if the final consensus differs
            </li>
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Sanity Checks</h3>
          <p>
            To maintain quality, Knights occasionally receive{' '}
            <span className="font-semibold">validation images</span> which we consider as gold
            standard ratings. Failing these sanity checks results in penalties:
          </p>
          <ul className="pl-8">
            <li>First failure in 24 hours: Warning notification</li>
            <li>
              Additional failures in 24 hours: 1 Smite per failure (reduces voting power and can
              lead to demotion)
            </li>
            <li>Sanity checks don&apos;t grant XP - they&apos;re purely for quality control</li>
          </ul>
        </div>
        <h2 className="text-lg font-semibold text-gold-9">Rewards & Progression</h2>
        <p>
          The following rewards are earned by <span className="font-semibold">Knights</span>:
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
            <li>Every correct rating equals 100 gold.</li>
            <li className="flex items-center gap-1">
              1,000 gold equals 1{' '}
              <span className="flex items-center gap-1">
                <CurrencyIcon size={16} currency="BUZZ" /> Yellow Buzz.
              </span>{' '}
            </li>
            <li>
              Gold must pass a 3-day settlement period before it can be converted into{' '}
              <span className="flex items-center gap-1">
                <CurrencyIcon size={16} currency="BUZZ" /> Yellow Buzz.
              </span>
            </li>
            <li>
              Gold amounts may be adjusted if the final consensus differs from your vote, even
              during the 3-day waiting period.
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
            Knights earn <span className="font-semibold">Fervor</span> by making accurate judgments
            consistently.
          </p>
          <ul className="pl-8">
            <li>Fervor = Total Ratings + (Correct Ratings × 100)</li>
            <li>This rewards both activity and accuracy</li>
            <li>Used for leaderboards and future rank achievements</li>
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 font-semibold">
            <ThemeIcon color="red">
              <IconHammer stroke={1.5} size={18} />
            </ThemeIcon>{' '}
            Smites
          </h3>
          <p>
            Knights may receive <span className="font-semibold">Smites</span> for failing sanity
            checks or from moderator intervention for serious violations.
          </p>
          <ul className="pl-8">
            <li>Each Smite reduces your voting weight</li>
            <li>Acolytes: 5 wrong answers at the same level = 1 Smite</li>
            <li>Knights: Repeated sanity check failures within 24 hours = Smites</li>
            <li className="font-semibold">Receiving 3 smites results in career reset to Level 1</li>
            <li>Smites can be cleansed by correct ratings or by moderator intervention</li>
          </ul>
        </div>
        <h2 className="text-lg font-semibold text-gold-9">Join the Order</h2>
        <p>
          Join us now and experience the excitement of Knights of New Order. Will you rise to the
          challenge and become a legendary knight? For further information, you can checkout the
          official{' '}
          <a
            className="text-blue-5 underline"
            href="https://education.civitai.com/knights-of-the-new-order-minigame/"
            rel="noopener noreferrer"
            target="_blank"
          >
            guide
          </a>
          .
        </p>
        {footer}
      </div>
    </Modal>
  );
}

type Props = { opened: boolean; onClose: VoidFunction; footer?: React.ReactNode };
