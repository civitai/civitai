import type { SelectProps } from '@mantine/core';
import { Button, ColorSwatch, Modal, useMantineTheme } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputMultiSelect,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import type { SimpleImageUploadState } from '~/libs/form/components/SimpleImageUpload';
import {
  ANNOUNCEMENT_IMAGE_WIDTH,
  announcementImageFormSchema,
  toAnnouncementImageFormValue,
  toAnnouncementImageKey,
} from '~/components/Announcements/announcement-image';
import type { UpsertAnnouncementSchema } from '~/server/schema/announcement.schema';
import { MAX_ANNOUNCEMENT_TARGET_USERS } from '~/server/schema/announcement.schema';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { dateWithoutTimezone, endOfDay, startOfDay } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  title: z.string(),
  content: z.string(),
  color: z.string(),
  domain: z.enum(DomainColor).array().default([DomainColor.all]),
  startsAt: z.date(),
  endsAt: z.date().nullish(),
  image: announcementImageFormSchema,
  disabled: z.boolean().optional(),
  linkText: z.string().optional(),
  linkUrl: z.string().optional(),
  targetUserIds: z.string().optional(),
  notifyTargetedUsers: z.boolean().optional(),
});

export const UPLOAD_IN_FLIGHT_MESSAGE = 'Wait for the banner image to finish uploading.';

export function parseTargetUserIds(value?: string) {
  const tokens = (value ?? '').split(/[\s,;]+/).filter(Boolean);
  const ids = new Set<number>();
  const invalid: string[] = [];
  for (const token of tokens) {
    const id = Number(token);
    if (Number.isInteger(id) && id > 0) ids.add(id);
    else invalid.push(token);
  }
  return { ids: [...ids], invalid };
}

const domainColorOptions = Object.values(DomainColor).map((domain) => ({
  value: domain,
  label: `${capitalize(domain)} ${domain === DomainColor.all ? 'Servers' : 'Server'}`,
}));

export function AnnouncementEditModal({
  announcement,
}: {
  announcement?: Partial<UpsertAnnouncementSchema>;
}) {
  const dialog = useDialogContext();

  // const startsAt = announcement?.startsAt ?? new Date();
  // const date = new Date(startsAt);
  // if (!announcement?.endsAt) date.setDate(startsAt.getDate() + 1);
  const endsAt = announcement?.endsAt;
  const action = announcement?.metadata?.actions?.[0];
  const queryUtils = trpc.useUtils();
  const startsAtRef = useRef<Date | null>(null);
  const isToday = announcement?.startsAt?.toDateString() === new Date().toDateString();
  // A banner upload in flight has NOT yet reached form state — see the guard in
  // `handleSubmit` and `UPLOAD_IN_FLIGHT_MESSAGE`.
  const [imageUploading, setImageUploading] = useState(false);

  const form = useForm({
    schema,
    defaultValues: {
      ...announcement,
      domain: announcement?.domain ?? [DomainColor.all],
      startsAt: announcement?.startsAt
        ? isToday
          ? announcement.startsAt
          : startOfDay(dateWithoutTimezone(announcement.startsAt))
        : new Date(),
      endsAt: endsAt ? startOfDay(dateWithoutTimezone(endsAt)) : null,
      image: toAnnouncementImageFormValue(announcement?.metadata),
      linkText: action?.linkText,
      linkUrl: action?.link,
    },
  });
  const theme = useMantineTheme();
  const colors = Object.keys(theme.colors);

  // Existing target set, loaded lazily when editing. Until it resolves the textarea is
  // disabled and `targetUserIds` is sent as undefined (leave targeting unchanged), so a
  // quick save can never silently wipe an announcement's targeting.
  const targetsQuery = trpc.announcement.getAnnouncementTargets.useQuery(
    { id: announcement?.id as number },
    { enabled: !!announcement?.id }
  );
  const targetsReady = !announcement?.id || targetsQuery.isSuccess;
  useEffect(() => {
    if (targetsQuery.data) form.setValue('targetUserIds', targetsQuery.data.join(', '));
  }, [targetsQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const watchedTargets = form.watch('targetUserIds');
  const targetCount = useMemo(
    () => parseTargetUserIds(watchedTargets).ids.length,
    [watchedTargets]
  );

  // Last banner key the form actually held. Replacing a banner is a two-step gesture —
  // remove (which clears form state) then drop — so at the moment an upload fails the
  // form no longer remembers what it is about to overwrite. Keeping the last non-empty
  // value lets a failed replacement be undone instead of silently saved as "no banner".
  const watchedImage = form.watch('image');
  const lastImageRef = useRef(toAnnouncementImageFormValue(announcement?.metadata));
  useEffect(() => {
    if (watchedImage) lastImageRef.current = watchedImage;
  }, [watchedImage]);

  function handleUploadStateChange(state: SimpleImageUploadState) {
    setImageUploading(state === 'uploading');
    if (state === 'uploading') form.clearErrors('image');
    // 🔴 A failed upload must not degrade into "the moderator removed the banner".
    // Restore what was there so a save cannot land the empty value the failed replace
    // left behind; the upload widget keeps its own error visible, and the restored
    // preview can be removed again if removal really was the intent.
    if (state === 'error' && lastImageRef.current) form.setValue('image', lastImageRef.current);
  }

  const { mutate, isPending: isLoading } = trpc.announcement.upsertAnnouncement.useMutation({
    onSuccess: () => {
      dialog.onClose();
      queryUtils.announcement.getAnnouncementsPaged.invalidate();
    },
    onError: (error) => {
      // A bad target list rejects the whole save server-side; pin that message to the
      // field the moderator has to fix.
      if (error.message.includes('target user id'))
        form.setError('targetUserIds', { type: 'manual', message: error.message });
      showErrorNotification({ title: 'Failed to save announcement', error });
    },
  });

  function handleSubmit({
    image,
    targetUserIds: targetUserIdsRaw,
    ...data
  }: z.infer<typeof schema>) {
    const { ids: targetUserIds, invalid } = parseTargetUserIds(targetUserIdsRaw);
    if (invalid.length) {
      form.setError('targetUserIds', {
        type: 'manual',
        message: `Not valid user ids: ${invalid.slice(0, 5).join(', ')}${
          invalid.length > 5 ? ` (+${invalid.length - 5} more)` : ''
        }`,
      });
      return;
    }
    if (targetUserIds.length > MAX_ANNOUNCEMENT_TARGET_USERS) {
      form.setError('targetUserIds', {
        type: 'manual',
        message: `Too many target users (${targetUserIds.length.toLocaleString()}). Max is ${MAX_ANNOUNCEMENT_TARGET_USERS.toLocaleString()}.`,
      });
      return;
    }

    // 🔴 A submit must not land while a banner upload is in flight. The upload widget
    // only writes the new key into form state once the upload reaches `success`, and
    // replacing a banner means removing the old one first — so a save mid-upload
    // persists the CLEARED value and the sitewide banner disappears. That is not
    // hypothetical: a lost `metadata.image` is what this whole change exists for.
    //
    // The Save button is disabled meanwhile; this guard additionally covers an
    // Enter-key submit, which a disabled button does not prevent.
    if (imageUploading) {
      form.setError('image', { type: 'manual', message: UPLOAD_IN_FLIGHT_MESSAGE });
      return;
    }

    const startsAtUtc = dayjs.utc(data.startsAt).toDate();
    const isToday = startsAtUtc.toDateString() === new Date().toDateString();
    const { domain } = data;

    mutate({
      ...announcement,
      ...data,
      targetUserIds: targetsReady ? targetUserIds : undefined,
      notifyTargetedUsers: targetsReady && targetUserIds.length > 0 && data.notifyTargetedUsers,
      title: data.title.trim(),
      content: data.content.trim(),
      startsAt: isToday
        ? startsAtRef.current ?? startsAtUtc
        : startOfDay(data.startsAt, { utc: true }),
      endsAt: endOfDay(data.endsAt, { utc: true }),
      metadata: {
        actions:
          data.linkText && data.linkUrl
            ? [{ type: 'button', link: data.linkUrl, linkText: data.linkText }]
            : undefined,
        // Wire format is unchanged: a bare object key string (or undefined).
        image: toAnnouncementImageKey(image),
      },
      domain: domain.length ? domain : [DomainColor.all],
    });
  }

  const renderSelectOption: SelectProps['renderOption'] = ({ option }) => {
    return (
      <div>
        <div className="flex items-center gap-2">
          <span>{option.label}</span>
          <ColorSwatch size={18} color={theme.colors[option.label][4]} />
        </div>
      </div>
    );
  };

  return (
    <Modal {...dialog} title={`${announcement?.id ? 'Edit' : 'Save'} Announcement`}>
      <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
        <InputText name="title" label="Title" />
        <InputTextArea name="content" label="Content" autosize />

        <InputMultiSelect
          name="domain"
          label="Domain"
          description="Select which server domains this announcement should appear on"
          data={domainColorOptions}
          placeholder="Select domains..."
          searchable
          clearable
        />

        <InputTextArea
          name="targetUserIds"
          label="Target User IDs"
          description={
            targetCount > 0
              ? `Targeting ${targetCount.toLocaleString()} user${targetCount === 1 ? '' : 's'}`
              : 'Optional. Comma, space, or newline separated user ids. Leave empty to show the announcement to everyone.'
          }
          placeholder={targetsReady ? 'e.g. 123, 456, 789' : 'Loading current targets...'}
          disabled={!targetsReady}
          autosize
          maxRows={6}
        />

        {targetCount > 0 && (
          <InputCheckbox
            name="notifyTargetedUsers"
            label="Send a notification to targeted users"
            description="On save, each targeted user also gets a system notification linking to the first announcement action (if any). Saving again with this checked sends it again."
          />
        )}

        {/*
          Banner upload — deliberately does NOT create an `Image` row.

          `SimpleImageUpload` uploads via `/api/v1/image-upload`, which mints an object
          key and a presigned PUT and nothing else. That is the point: `deleteImageFromS3`
          is row-scoped, not bucket-scoped — every one of its call sites hands it an
          `Image` row's id and url. A key that is not any `Image.url` therefore cannot be
          reached by any deletion path in the app, so the banner cannot be deleted out
          from under a live announcement. That is exactly the failure that broke a
          sitewide announcement banner for every user. Membership badges already use this
          same no-row pattern.

          🔴 DO NOT "fix" this by adding a `createImage` / `dbWrite.image` call here.
          Creating the row is what makes the object deletable, which reintroduces the bug.

          🔴 Accepted, documented cost: these keys are intentionally UNREGISTERED — no
          `Image` row, so no garbage collector will ever reclaim them. Any future
          orphan-cleanup job over the uploads bucket keyed on "object has no `Image` row"
          MUST exclude keys referenced by `Announcement.metadata->>'image'` (and the other
          bare-key media pointers: `Cosmetic.data.url`, `Tool.icon`/`metadata.header`,
          `Partner.logo`, `User.image`), or it will reproduce this outage from a new
          direction. `~/server/jobs/announcement-media-check` monitors for exactly that.
        */}
        <InputSimpleImageUpload
          name="image"
          label="Banner Image"
          description="Shown alongside the announcement. Uploads are stored as a bare object key."
          previewWidth={ANNOUNCEMENT_IMAGE_WIDTH}
          withNsfwLevel={false}
          onUploadStateChange={handleUploadStateChange}
        />

        <InputSelect
          name="color"
          label="Color"
          data={colors.map((color) => ({ value: color, label: color }))}
          renderOption={renderSelectOption}
          searchable
          clearable
        />

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputDatePicker
            name="startsAt"
            label="Starts At"
            onChange={(value) => {
              startsAtRef.current = value ? new Date() : null;
            }}
          />
          <InputDatePicker name="endsAt" label="Ends At" />
        </div>

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputText name="linkText" label="CTA Text" />
          <InputText name="linkUrl" label="CTA Url" />
        </div>

        <InputCheckbox name="disabled" label="Disabled" />
        <Button type="submit" loading={isLoading} disabled={imageUploading}>
          {imageUploading ? 'Uploading image…' : 'Save'}
        </Button>
      </Form>
    </Modal>
  );
}
