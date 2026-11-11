import { ActionIcon, Modal, Text, UnstyledButton } from '@mantine/core';
import { IconPin, IconPinFilled } from '@tabler/icons-react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  openRemixApp,
  RemixAppIcon,
  type RemixMenuApp,
  useRemixAppPrices,
} from '~/components/Image/Remix/RemixApps';
import { useRemixAppPins } from '~/components/Image/Remix/useRemixAppPins';

export type RemixAppPickerProps = {
  /** Every app this viewer may run on this image, as the menu filtered them. */
  apps: RemixMenuApp[];
  imageId: number;
  onRun?: () => void;
};

/** "See more": every app, to run one or to pin it to the menu. */
export function RemixAppPicker({ apps, imageId, onRun }: RemixAppPickerProps) {
  const dialog = useDialogContext();
  const { loading, priceOf } = useRemixAppPrices(imageId, true);
  const { pins, toggle, canEdit } = useRemixAppPins();
  const offered = apps.map((app) => app.slug);

  return (
    <Modal {...dialog} title="Remix apps" size="md" centered>
      <div className="flex flex-col gap-1">
        {apps.map((app) => {
          const price = priceOf(app.slug);
          const refusal = price && 'refusal' in price ? price.refusal : undefined;
          const cost = price && 'cost' in price ? price.cost : undefined;
          const pinned = pins.includes(app.slug);
          return (
            <div key={app.slug} className="flex items-center gap-2">
              <UnstyledButton
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 hover:bg-gray-1 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-dark-5"
                // Nothing runs without a price on screen, as in the menu.
                disabled={cost == null}
                onClick={() => {
                  dialog.onClose();
                  onRun?.();
                  openRemixApp(app, imageId);
                }}
              >
                <RemixAppIcon icon={app.icon} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <Text size="sm" fw={600} lh={1.2}>
                    {app.name}
                  </Text>
                  {(refusal ?? app.description) && (
                    <Text size="xs" c="dimmed" lh={1.2} lineClamp={2}>
                      {refusal ?? app.description}
                    </Text>
                  )}
                </div>
                {!refusal && (
                  <CurrencyBadge
                    currency="BUZZ"
                    unitAmount={cost ?? 0}
                    loading={loading}
                    size="sm"
                  />
                )}
              </UnstyledButton>
              <ActionIcon
                variant={pinned ? 'light' : 'subtle'}
                color={pinned ? 'blue' : 'gray'}
                disabled={!canEdit}
                aria-label={`${pinned ? 'Unpin' : 'Pin'} ${app.name}`}
                aria-pressed={pinned}
                onClick={() => toggle(app.slug, offered)}
              >
                {pinned ? <IconPinFilled size={16} /> : <IconPin size={16} />}
              </ActionIcon>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
