import { Modal } from '@mantine/core';

export function NewOrderRulesModal({ opened, onClose, footer }: Props) {
  return (
    <Modal
      size="lg"
      onClose={onClose}
      opened={opened}
      title={<p className="text-lg font-semibold text-orange-5">What is Knights of New Order?</p>}
      centered
    >
      <div className="flex flex-col gap-4">
        <p>
          Knights of New Order is a thrilling game where players take on the roles of knights in a
          fantastical world. Engage in epic battles, form alliances, and embark on quests to become
          the ultimate knight.
        </p>
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
