import { Button, Modal, Stack } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useMemo } from 'react';
import { Controller } from 'react-hook-form';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  Form,
  InputCheckbox,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import {
  REWARDS_BONUS_MULTIPLIER_OPTIONS,
  type UpsertRewardsBonusEventSchema,
} from '~/server/schema/rewards-bonus-event.schema';
import dayjs from '~/shared/utils/dayjs';
import { fromDisplayUTC, toDisplayUTC } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const multiplierLabels: Record<number, string> = {
  15: '50% more (1.5x)',
  20: '2x',
  30: '3x',
  40: '4x',
};

const multiplierOptions = REWARDS_BONUS_MULTIPLIER_OPTIONS.map((value) => ({
  value: String(value),
  label: multiplierLabels[value] ?? `${value / 10}x`,
}));

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(5000).optional(),
  multiplier: z.string(),
  articleUrl: z.string().optional(),
  bannerLabel: z.string().trim().max(60).optional(),
  enabled: z.boolean().default(false),
  startsAt: z.date().nullish(),
  endsAt: z.date().nullish(),
});

function extractArticleId(input?: string | null): number | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/articles\/(\d+)/);
  if (match) return Number(match[1]);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return null;
}

export function RewardsBonusEventEditModal({
  event,
}: {
  event?: {
    id?: number;
    name?: string;
    description?: string | null;
    multiplier?: number;
    articleId?: number | null;
    bannerLabel?: string | null;
    enabled?: boolean;
    startsAt?: Date | null;
    endsAt?: Date | null;
  };
}) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();

  const defaultMultiplier = event?.multiplier ?? 20;
  const form = useForm({
    schema,
    defaultValues: {
      name: event?.name ?? '',
      description: event?.description ?? '',
      multiplier: String(defaultMultiplier),
      articleUrl: event?.articleId ? `/articles/${event.articleId}` : '',
      bannerLabel: event?.bannerLabel ?? '',
      enabled: event?.enabled ?? false,
      startsAt: event?.startsAt ? toDisplayUTC(event.startsAt) : undefined,
      endsAt: event?.endsAt ? toDisplayUTC(event.endsAt) : undefined,
    },
  });

  const title = useMemo(
    () => (event?.id ? 'Edit Rewards Bonus Event' : 'Create Rewards Bonus Event'),
    [event?.id]
  );

  const { mutate, isLoading } = trpc.rewardsBonusEvent.upsert.useMutation({
    onSuccess: () => {
      queryUtils.rewardsBonusEvent.getPaged.invalidate();
      queryUtils.buzz.getUserMultipliers.invalidate();
      showSuccessNotification({ message: 'Rewards bonus event saved' });
      dialog.onClose();
    },
    onError: (error) => {
      showErrorNotification({ title: 'Could not save event', error: new Error(error.message) });
    },
  });

  function handleSubmit(data: z.infer<typeof schema>) {
    const startsAt = data.startsAt
      ? dayjs.utc(fromDisplayUTC(data.startsAt)).startOf('day').toDate()
      : null;
    const endsAt = data.endsAt
      ? dayjs.utc(fromDisplayUTC(data.endsAt)).endOf('day').toDate()
      : null;

    const payload: UpsertRewardsBonusEventSchema = {
      id: event?.id,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      multiplier: Number(data.multiplier),
      articleId: extractArticleId(data.articleUrl),
      bannerLabel: data.bannerLabel?.trim() || null,
      enabled: data.enabled,
      startsAt,
      endsAt,
    };
    mutate(payload);
  }

  return (
    <Modal {...dialog} title={title} size="lg">
      <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
        <InputText
          name="name"
          label="Name"
          description="Shown at the top of the info modal. e.g. Transition Thank-You Bonus"
          withAsterisk
        />
        <InputTextArea
          name="description"
          label="Description"
          description="Shown in the info modal. Supports markdown (paragraphs, **bold**, *italic*, [links](/url), line breaks)."
          autosize
          minRows={3}
        />
        <InputSelect
          name="multiplier"
          label="Multiplier"
          description="Global Blue Buzz reward multiplier while this event is active."
          data={multiplierOptions}
          withAsterisk
        />
        <InputText
          name="articleUrl"
          label="Article link"
          description="Paste a Civitai article URL or the article ID. We'll extract the ID and link it from the info modal as a 'Learn more' button. Works on both civitai.com and civitai.red."
          placeholder="https://civitai.com/articles/28936"
        />
        <InputText
          name="bannerLabel"
          label="Banner label override"
          description="Overrides the default 'BONUS REWARDS ACTIVE' text in the site-wide banner. Leave blank to use the default."
          placeholder="e.g. HOLIDAY BONUS or TRANSITION THANK-YOU"
        />
        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <Controller
            control={form.control}
            name="startsAt"
            render={({ field }) => (
              <DatePickerInput
                label="Starts at"
                placeholder="No start date"
                value={field.value ?? null}
                onChange={(v) => field.onChange(v ?? null)}
                clearable
              />
            )}
          />
          <Controller
            control={form.control}
            name="endsAt"
            render={({ field }) => {
              const startsAtValue = form.watch('startsAt');
              const today = dayjs().startOf('day').toDate();
              const minEndDate =
                startsAtValue && startsAtValue.getTime() > today.getTime()
                  ? startsAtValue
                  : today;
              return (
                <DatePickerInput
                  label="Ends at"
                  placeholder="No end date"
                  value={field.value ?? null}
                  onChange={(v) => field.onChange(v ?? null)}
                  minDate={minEndDate}
                  clearable
                />
              );
            }}
          />
        </div>
        <InputCheckbox
          name="enabled"
          label="Enabled (must also be within the start/end window to be active)"
        />
        <Stack gap="xs" pt="sm">
          <Button type="submit" loading={isLoading}>
            Save
          </Button>
        </Stack>
      </Form>
    </Modal>
  );
}
