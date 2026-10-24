import { Anchor, Button, Checkbox, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { useMutateMyServices } from '~/components/CreatorShop/Services/creator-service.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  SELLER_AFFIRMATION_INTRO,
  SELLER_AFFIRMATION_ITEMS,
  SERVICES_TERMS_VERSION,
} from '~/shared/constants/creator-service-terms.constants';

const TOS_TEXT = 'Terms of Service';

function AffirmationItem({ text }: { text: string }) {
  const [before, after] = text.split(TOS_TEXT);
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      <Anchor component={NextLink} href="/content/tos" target="_blank" inherit>
        {TOS_TEXT}
      </Anchor>
      {after}
    </>
  );
}

/** The seller's confirmation, ticked before a service can be published. */
export function SellerAffirmationCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox
      checked={checked}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label={
        <Stack gap={4}>
          <Text size="sm">{SELLER_AFFIRMATION_INTRO}</Text>
          <List size="sm" spacing={2}>
            {SELLER_AFFIRMATION_ITEMS.map((item) => (
              <List.Item key={item}>
                <AffirmationItem text={item} />
              </List.Item>
            ))}
          </List>
        </Stack>
      }
    />
  );
}

/** Publishing a saved draft or paused service that has no current confirmation on file. */
export function PublishServiceModal({ offering }: { offering: ServiceOffering }) {
  const dialog = useDialogContext();
  const { setStatus } = useMutateMyServices();
  const [affirmed, setAffirmed] = useState(false);

  return (
    <Modal {...dialog} size="lg" title={`Publish: ${offering.title}`}>
      <Stack gap="md">
        <SellerAffirmationCheckbox checked={affirmed} onChange={setAffirmed} />
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            color="yellow"
            disabled={!affirmed}
            loading={setStatus.isPending}
            onClick={() =>
              setStatus.mutate(
                { id: offering.id, status: 'Active', affirmedTermsVersion: SERVICES_TERMS_VERSION },
                { onSuccess: dialog.onClose }
              )
            }
          >
            Publish service
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
