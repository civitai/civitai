import { Button, Group, Modal, SimpleGrid, Stack } from '@mantine/core';
import { useState } from 'react';
import type * as z from 'zod';
import { SellerAffirmationCheckbox } from '~/components/CreatorShop/Services/SellerAffirmation';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { useMutateMyServices } from '~/components/CreatorShop/Services/creator-service.util';
import { Form, InputNumber, InputSelect, InputText, InputTextArea, useForm } from '~/libs/form';
import { upsertServiceOfferingSchema } from '~/server/schema/creator-service.schema';
import {
  SERVICE_DELIVERY_DAYS_MAX,
  SERVICE_DELIVERY_DAYS_MIN,
  SERVICE_DESCRIPTION_MAX,
  SERVICE_OPEN_DEALS_MAX,
  SERVICE_OPEN_DEALS_MIN,
  SERVICE_PRICE_MAX,
  SERVICE_PRICE_MIN,
  SERVICE_REVISIONS_MAX,
  SERVICE_OFFERING_DEFAULT_RATING,
  SERVICE_OFFERING_RATINGS,
  SERVICE_TITLE_MAX,
} from '~/shared/constants/creator-service.constants';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import { isMatureServiceLevel } from '~/shared/constants/creator-services.constants';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { ServiceOfferingStatus, ServicePreviewKind } from '~/shared/utils/prisma/enums';

const formSchema = upsertServiceOfferingSchema.omit({
  id: true,
  publish: true,
  affirmedTermsVersion: true,
});
type FormValues = z.infer<typeof formSchema>;

const previewKindOptions = [
  { value: ServicePreviewKind.Image, label: 'Image preview' },
  { value: ServicePreviewKind.Video, label: 'Video preview' },
  { value: ServicePreviewKind.SampleOutputs, label: 'Sample outputs' },
  { value: ServicePreviewKind.None, label: 'No preview' },
];

const ratingOptions = SERVICE_OFFERING_RATINGS.map((rating) => ({
  value: rating,
  label: isMatureServiceLevel(rating)
    ? `${browsingLevelLabels[rating]} (shown on civitai.red only)`
    : browsingLevelLabels[rating],
}));

export function ServiceOfferingFormModal({ offering }: { offering?: ServiceOffering }) {
  const dialog = useDialogContext();
  const { upsert } = useMutateMyServices();

  const form = useForm({
    schema: formSchema,
    defaultValues: {
      title: offering?.title ?? '',
      description: offering?.description ?? '',
      price: offering?.price ?? 1000,
      deliveryDays: offering?.deliveryDays ?? 5,
      revisionsIncluded: offering?.revisionsIncluded ?? 2,
      maxOpenDeals: offering?.maxOpenDeals ?? 3,
      previewKind: offering?.previewKind ?? ServicePreviewKind.Image,
      maxNsfwLevel: offering?.maxNsfwLevel ?? SERVICE_OFFERING_DEFAULT_RATING,
    },
  });

  const isActive = offering?.status === ServiceOfferingStatus.Active;
  const needsAffirmation = !offering?.termsAffirmed;
  const [affirmed, setAffirmed] = useState(false);
  const canPublish = !needsAffirmation || affirmed;
  const save = (publish: boolean) =>
    form.handleSubmit(async (values: FormValues) => {
      await upsert.mutateAsync({
        ...values,
        id: offering?.id,
        publish,
        affirmedTermsVersion: publish && affirmed ? SERVICES_TERMS_VERSION : undefined,
      });
      dialog.onClose();
    });

  return (
    <Modal {...dialog} size="lg" title={offering ? 'Edit service' : 'New service'}>
      <Form form={form}>
        <Stack gap="md">
          <InputText name="title" label="Title" maxLength={SERVICE_TITLE_MAX} withAsterisk />
          <InputTextArea
            name="description"
            label="What the buyer gets"
            autosize
            minRows={3}
            maxLength={SERVICE_DESCRIPTION_MAX}
            withAsterisk
          />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <InputNumber
              name="price"
              label="Price (Buzz)"
              min={SERVICE_PRICE_MIN}
              max={SERVICE_PRICE_MAX}
              step={100}
              withAsterisk
            />
            <InputNumber
              name="deliveryDays"
              label="Delivery days"
              min={SERVICE_DELIVERY_DAYS_MIN}
              max={SERVICE_DELIVERY_DAYS_MAX}
              withAsterisk
            />
            <InputNumber
              name="revisionsIncluded"
              label="Revisions"
              min={0}
              max={SERVICE_REVISIONS_MAX}
              withAsterisk
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <InputNumber
              name="maxOpenDeals"
              label="Open slots at once"
              inputWrapperOrder={['label', 'input', 'description', 'error']}
              description="How many buyers can have a request open with you."
              min={SERVICE_OPEN_DEALS_MIN}
              max={SERVICE_OPEN_DEALS_MAX}
              withAsterisk
            />
            <InputSelect
              name="previewKind"
              label="Preview you deliver"
              data={previewKindOptions}
              withAsterisk
            />
          </SimpleGrid>
          <InputSelect
            name="maxNsfwLevel"
            label="Highest rating you deliver"
            description="Buyers only see this service where that rating is allowed. Changing it later applies to new requests only."
            data={ratingOptions}
            withAsterisk
          />
          {!isActive && needsAffirmation && (
            <SellerAffirmationCheckbox checked={affirmed} onChange={setAffirmed} />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.onClose}>
              Cancel
            </Button>
            {isActive ? (
              <Button onClick={save(false)} loading={upsert.isPending}>
                Save changes
              </Button>
            ) : (
              <>
                <Button variant="light" onClick={save(false)} loading={upsert.isPending}>
                  {offering?.status === ServiceOfferingStatus.Paused ? 'Save' : 'Save draft'}
                </Button>
                <Button
                  color="yellow"
                  onClick={save(true)}
                  loading={upsert.isPending}
                  disabled={!canPublish}
                >
                  Publish service
                </Button>
              </>
            )}
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
