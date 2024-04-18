import { Button, Group, Stack } from '@mantine/core';
import React from 'react';

import {
  Form,
  InputCheckbox,
  InputRTE,
  InputSectionItems,
  InputSimpleImageUpload,
  InputText,
  useForm,
} from '~/libs/form';
import { z } from 'zod';
import { CosmeticShopSectionGetById } from '~/types/router';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import {
  CosmeticShopSectionMeta,
  upsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import { constants } from '~/server/common/constants';

const formSchema = upsertCosmeticShopSectionInput.extend({
  items: z
    .array(z.object({ id: z.number(), title: z.string(), description: z.string().optional() }))
    .optional(),
});

type Props = {
  section?: CosmeticShopSectionGetById;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export const CosmeticShopSectionUpsertForm = ({ section, onSuccess, onCancel }: Props) => {
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...section,
      meta: {
        hideTitle: false,
        ...((section?.meta ?? {}) as CosmeticShopSectionMeta),
      },
      items:
        (section?.items ?? []).map((item) => ({
          id: item.shopItem.id,
          title: item.shopItem.title,
          description: item.shopItem.description ?? undefined,
        })) ?? [],
    },
    shouldUnregister: false,
  });

  const [image] = form.watch(['image']);
  const { upsertShopSection, upsertingShopSection } = useMutateCosmeticShop();

  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      await upsertShopSection({
        ...data,
        items: (data.items ?? []).map((item) => item.id),
      });

      if (!data.id) {
        form.reset();
      }

      onSuccess?.();
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="md">
        <Stack spacing="md">
          <InputSimpleImageUpload
            name="image"
            label="Header Image"
            description={`Suggested resolution: ${constants.cosmeticShop.sectionImageWidth}x${constants.cosmeticShop.sectionImageHeight}px`}
            aspectRatio={constants.cosmeticShop.sectionImageAspectRatio}
          />
          <InputText
            name="title"
            label="Title"
            description="This title will be shown in the shop. It can be different from the cosmetic's original name"
            withAsterisk
          />
          <InputCheckbox
            name="meta.hideTitle"
            label="Hide Title"
            description="Hides the title from the shop section. Useful if the image already contains the title"
          />
          <InputCheckbox
            name="published"
            label="Published"
            description="Makes this section visible on the store"
          />
          <InputRTE
            name="description"
            description="This description will be shown in the shop"
            label="Content"
            editorSize="xl"
            includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
            withAsterisk
            stickyToolbar
          />
          <InputSectionItems
            name="items"
            label="Items in section"
            description="Items that will be sold in this section. The order displayed here is the order they will appear in"
          />
        </Stack>
        <Group position="right">
          {onCancel && (
            <Button
              loading={upsertingShopSection}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancel?.();
              }}
              color="gray"
            >
              Cancel
            </Button>
          )}
          <Button loading={upsertingShopSection} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
};
