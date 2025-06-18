import type { ChipProps, TooltipProps } from '@mantine/core';
import {
  ActionIcon,
  Avatar,
  Button,
  Chip,
  Divider,
  Grid,
  Group,
  Input,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconCalendar, IconCalendarDue, IconTrash } from '@tabler/icons-react';
import React from 'react';
import { z } from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useMutatePurchasableReward } from '~/components/PurchasableRewards/purchasableRewards.util';
import {
  Form,
  InputDatePicker,
  InputNumber,
  InputRTE,
  InputSimpleImageUpload,
  InputSwitch,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { purchasableRewardUpsertSchema } from '~/server/schema/purchasable-reward.schema';
import { PurchasableRewardUsage } from '~/shared/utils/prisma/enums';
import type { PurchasableRewardGetById } from '~/types/router';
import { getDisplayName } from '~/utils/string-helpers';

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const chipProps: Partial<ChipProps> = {
  size: 'sm',
  radius: 'xl',
  variant: 'filled',
  tt: 'capitalize',
};

const formSchema = purchasableRewardUpsertSchema.omit({ codes: true }).extend({
  codes: z.string(),
});

export function PurchasableRewardUpsertForm({
  purchasableReward,
  onSave,
}: {
  purchasableReward?: PurchasableRewardGetById;
  onSave?: (purchasableReward: { id: number }) => void;
}) {
  const theme = useMantineTheme();
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      usage: PurchasableRewardUsage.SingleUse,
      ...(purchasableReward ?? {}),
      codes: (purchasableReward?.codes ?? []).join('\n'),
    },
    shouldUnregister: false,
  });

  const [usage, coverImage] = form.watch(['usage', 'coverImage']);

  const { upsertPurchasableReward, upsertingPurchasableReward } = useMutatePurchasableReward();
  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      const result = await upsertPurchasableReward({
        ...data,
        codes: data.codes.split('\n').filter((code) => code.trim().length > 0),
      });

      if (result?.id) {
        onSave?.(result);
      }
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap={32}>
        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack gap={32}>
              <Stack gap="xl">
                <Group grow wrap="nowrap">
                  {coverImage && (
                    <div style={{ position: 'relative', width: 124, flexGrow: 0 }}>
                      <Avatar
                        src={getEdgeUrl(coverImage?.url, { transcode: false })}
                        size={124}
                        radius="sm"
                      />
                      <Tooltip label="Remove image">
                        <LegacyActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          onClick={() =>
                            form.setValue(
                              'coverImage',
                              purchasableReward?.coverImage?.id ? null : undefined
                            )
                          }
                          style={{
                            position: 'absolute',
                            top: `calc(var(--mantine-spacing-xs) * 0.4)`,
                            right: `calc(var(--mantine-spacing-xs) * 0.4)`,
                            zIndex: 1,
                          }}
                        >
                          <IconTrash />
                        </LegacyActionIcon>
                      </Tooltip>
                    </div>
                  )}
                  <InputSimpleImageUpload
                    name="coverImage"
                    label="Cover Image"
                    description="This will represent this reward in the rewards page. Ideal resolution is 1024x1024."
                    aspectRatio={1}
                    // Im aware ideally this should ideally be 450, but images will look better on a higher res here
                    previewWidth={96}
                    previewDisabled
                    style={{ maxWidth: '100%' }}
                  />
                </Group>
                <InputText
                  name="title"
                  label="Title"
                  placeholder="e.g.:A cool reward"
                  withAsterisk
                />

                <InputRTE
                  name="about"
                  label="What's this reward about?"
                  editorSize="xl"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                  withAsterisk
                  stickyToolbar
                />
                <InputRTE
                  name="redeemDetails"
                  label="How will it be redeemed?"
                  editorSize="xl"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                  withAsterisk
                  stickyToolbar
                />
                <InputRTE
                  name="termsOfUse"
                  label="Terms of use"
                  editorSize="xl"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                  withAsterisk
                  stickyToolbar
                />
                <InputNumber
                  name="unitPrice"
                  label="Buzz Price"
                  placeholder="How much will this reward cost in Buzz?"
                  step={100}
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  format={undefined}
                  withAsterisk
                />
                <Input.Wrapper
                  label="Usage"
                  description="Specify how many times codes can be used. For single use, 1 distinct code is given to each user. For multi-use, the same code will be used by multiple users."
                  descriptionProps={{ mb: 'md' }}
                  withAsterisk
                >
                  <Group>
                    {Object.values(PurchasableRewardUsage).map((type, index) => (
                      <Chip
                        key={index}
                        value={type}
                        {...chipProps}
                        checked={usage === type}
                        onClick={() => {
                          form.setValue('usage', type);
                        }}
                      >
                        <span>{getDisplayName(type)}</span>
                      </Chip>
                    ))}
                  </Group>
                </Input.Wrapper>
                <InputTextArea
                  name="codes"
                  label="Codes/Links"
                  description="Enter one code/link per line. These will be used to redeem the reward. If rewards are Multi-use, one code is enough"
                  placeholder="e.g.: CODE_123"
                  rows={3}
                  autosize
                />
                <Divider label="Optional details" />
                <Group gap="xl" grow>
                  <InputDatePicker
                    name="availableFrom"
                    label="Available From (optional)"
                    placeholder="Reward will appear from this date onwards"
                    leftSection={<IconCalendar size={16} />}
                    clearable
                  />
                  <InputDatePicker
                    name="availableTo"
                    label="Available To (optional)"
                    placeholder="Reward will be available until this date"
                    leftSection={<IconCalendarDue size={16} />}
                    clearable
                  />
                </Group>
                {usage === PurchasableRewardUsage.MultiUse && (
                  <InputNumber
                    name="availableCount"
                    label="Limit the number of times this reward can be purchased as a whole"
                    placeholder="How many rewards are available?"
                    description="Leave empty for unlimited. In the case of single-use codes, codes will be taken by the users causing this number not to be of much use."
                    clearable
                  />
                )}
              </Stack>
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Stack>
              <Divider label="Properties" />
              <InputSwitch
                name="archived"
                label={
                  <Stack gap={4}>
                    <Group gap={4}>
                      <Text inline>Archived</Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      This reward is not available anymore
                    </Text>
                  </Stack>
                }
              />
            </Stack>
          </Grid.Col>
        </Grid>
        <Group justify="flex-end">
          <Button loading={upsertingPurchasableReward} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}
