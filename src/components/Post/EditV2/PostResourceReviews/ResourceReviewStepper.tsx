import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Modal,
  Progress,
  Select,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconCircleDashed, IconMessageCircle, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import * as z from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  normalizeComment,
  shouldNudgeForComment,
} from '~/components/Post/EditV2/PostResourceReviews/postResourceReviews.utils';
import { ResourceCover } from '~/components/Post/EditV2/PostResourceReviews/ResourceCover';
import { usePostResourceReviews } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Form, InputRTE, useForm } from '~/libs/form';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

/** What the dialog needs from a post image; it renders outside `PostEditProvider`. */
export type StepperImage = { id: number; url: string; type: string; modelVersionIds: number[] };

export type ResourceReviewStepperProps = {
  postId: number;
  ownerId: number;
  /** Starting resource; the first unrated one when omitted. */
  modelVersionId?: number;
  images: StepperImage[];
};

/** Past this many resources the per-resource segments shrink to a dotted line. */
const MAX_SEGMENTS = 12;

const schema = z.object({ details: z.string().optional() });

type Review = ReturnType<typeof usePostResourceReviews>['reviews'][number];

const startIndex = (reviews: Review[], modelVersionId?: number) => {
  const byId = reviews.findIndex((r) => r.modelVersionId === modelVersionId);
  if (byId >= 0) return byId;
  const unrated = reviews.findIndex((r) => r.reviewRecommended == null);
  return unrated >= 0 ? unrated : 0;
};

function segmentColor(review: Review, current: boolean) {
  if (current) return 'blue.6';
  if (review.reviewRecommended === true) return 'success.6';
  if (review.reviewRecommended === false) return 'red.6';
  return 'dark.4';
}

function StateIcon({ review, current }: { review: Review; current: boolean }) {
  if (current) return <IconMessageCircle size={16} color="var(--mantine-color-blue-5)" />;
  if (review.reviewRecommended === true)
    return (
      <Text c="success.5" inline>
        <ThumbsUpIcon size={16} filled />
      </Text>
    );
  if (review.reviewRecommended === false)
    return (
      <Text c="red" inline>
        <ThumbsDownIcon size={16} filled />
      </Text>
    );
  return <IconCircleDashed size={16} color="var(--mantine-color-dimmed)" />;
}

export function ResourceReviewStepper({
  postId,
  ownerId,
  modelVersionId,
  images,
}: ResourceReviewStepperProps) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const { reviews, canReview, isPending, rate, saveDetails } = usePostResourceReviews({
    postId,
    ownerId,
  });
  const browsingLevel = useBrowsingLevelDebounced();
  // Covers come from an owner-only query that filters by the viewer's browsing level server-side.
  const { data: covers } = trpc.post.getResourceCovers.useQuery(
    { id: postId, browsingLevel },
    { enabled: canReview }
  );
  const [index, setIndex] = useState(() => startIndex(reviews, modelVersionId));
  const [saving, setSaving] = useState(false);
  const drafts = useRef(new Map<number, string>());
  const railRef = useRef<HTMLDivElement>(null);

  const last = reviews.length - 1;
  const current: Review | undefined = reviews[Math.min(index, last)];
  const currentId = current?.modelVersionId as number | undefined;
  const saved = current?.reviewDetails ?? '';

  const form = useForm({ schema, defaultValues: { details: saved } });
  useEffect(() => {
    if (currentId == null) return;
    form.reset({ details: drafts.current.get(currentId) ?? saved });
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    railRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!canReview || !current || currentId == null) return null;

  const comment = form.watch('details') ?? '';
  const recommended = current.reviewRecommended;
  const busy = saving || isPending(currentId);
  const usedIn = images.filter((image) => image.modelVersionIds.includes(currentId));
  const isLast = index >= last;
  const ratedCount = reviews.filter((r) => r.reviewRecommended != null).length;

  const goTo = (next: number) => {
    drafts.current.set(currentId, form.getValues('details') ?? '');
    setIndex(next);
  };
  const advance = () => (isLast ? dialog.onClose() : goTo(index + 1));

  const saveAndNext = async () => {
    if (recommended == null) return;
    const draft = normalizeComment(form.getValues('details'));
    if (draft !== normalizeComment(saved)) {
      setSaving(true);
      let result;
      try {
        result = await saveDetails(currentId, draft);
      } finally {
        setSaving(false);
      }
      if (result !== 'saved') return;
    }
    drafts.current.delete(currentId);
    advance();
  };

  const picker = (
    <Select
      aria-label="Resource"
      value={String(currentId)}
      data={reviews.map((r, i) => ({
        value: String(r.modelVersionId),
        label: `${i + 1} of ${reviews.length} · ${r.modelName}`,
      }))}
      onChange={(value) => {
        const next = reviews.findIndex((r) => String(r.modelVersionId) === value);
        if (next >= 0) goTo(next);
      }}
      allowDeselect={false}
    />
  );

  const closeButton = (
    <ActionIcon variant="subtle" color="gray" aria-label="Close" onClick={dialog.onClose}>
      <IconX size={18} />
    </ActionIcon>
  );

  const rail = (
    <Stack ref={railRef} gap={2} w={250} p="sm" className="shrink-0 overflow-y-auto">
      {reviews.map((review, i) => (
        <UnstyledButton
          key={review.modelVersionId}
          onClick={() => goTo(i)}
          aria-current={i === index}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-1 hover:dark:bg-dark-5"
          style={
            i === index
              ? {
                  background: 'var(--mantine-color-blue-light)',
                  boxShadow: 'inset 3px 0 0 var(--mantine-color-blue-filled)',
                }
              : undefined
          }
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <StateIcon review={review} current={i === index} />
          </span>
          {!isMobile && (
            <ResourceCover image={covers?.[review.modelVersionId as number]} size={24} />
          )}
          <div className="min-w-0">
            <Text size="sm" lineClamp={1} fw={i === index ? 600 : undefined}>
              {review.modelName}
            </Text>
            <Text size="xs" c="dimmed" lineClamp={1}>
              {review.modelVersionName}
            </Text>
          </div>
        </UnstyledButton>
      ))}
    </Stack>
  );

  const body = (
    <Stack gap="md" p="md" className="min-w-0 flex-1 overflow-y-auto">
      {!isMobile && (
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={6} className="flex-1">
            <>
              {reviews.length <= MAX_SEGMENTS ? (
                <Group gap={4} wrap="nowrap">
                  {reviews.map((review, i) => (
                    <Box
                      key={review.modelVersionId}
                      h={4}
                      className="flex-1 rounded-full"
                      bg={segmentColor(review, i === index)}
                    />
                  ))}
                </Group>
              ) : (
                <Progress
                  value={(ratedCount / reviews.length) * 100}
                  size={4}
                  color="success"
                  aria-label="Resources rated"
                />
              )}
              <Text size="xs" c="dimmed">
                {index + 1} of {reviews.length}
                {reviews.length > MAX_SEGMENTS && ` · ${ratedCount} rated`}
              </Text>
            </>
          </Stack>
          {closeButton}
        </Group>
      )}

      <Group gap="sm" wrap="nowrap">
        <ResourceCover image={covers?.[currentId]} size={64} />
        <div className="min-w-0">
          <Title order={3}>{current.modelName}</Title>
          <Text size="sm" c="dimmed">
            {getDisplayName(current.modelType ?? 'unknown')} · {current.modelVersionName}
          </Text>
        </div>
      </Group>

      {images.length > 1 && (
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Used in {usedIn.length} of your {images.length} images
          </Text>
          <Group gap={6} wrap="nowrap" className="overflow-x-auto">
            {usedIn.map((image) => (
              <Box key={image.id} w={56} h={56} className="shrink-0 overflow-hidden rounded-md">
                <EdgeMedia src={image.url} type={image.type as 'image'} width={112} />
              </Box>
            ))}
          </Group>
        </Stack>
      )}

      <Stack gap={6}>
        <Text size="sm" fw={600}>
          Would you recommend it?
        </Text>
        <Group grow>
          <Button
            size="md"
            radius="md"
            color="success"
            variant={recommended === true ? 'light' : 'default'}
            leftSection={<ThumbsUpIcon size={18} filled={recommended === true} />}
            disabled={busy}
            onClick={() => (recommended !== true ? rate(currentId, true) : undefined)}
          >
            Recommend
          </Button>
          <Button
            size="md"
            radius="md"
            color="red"
            variant={recommended === false ? 'light' : 'default'}
            leftSection={<ThumbsDownIcon size={18} filled={recommended === false} />}
            disabled={busy}
            onClick={() => (recommended !== false ? rate(currentId, false) : undefined)}
          >
            Not for me
          </Button>
        </Group>
      </Stack>

      <Stack gap={6}>
        <Text size="sm" fw={600}>
          Comment (optional)
        </Text>
        <Form
          form={form}
          onSubmit={() => undefined}
          className={
            isMobile ? '[&_.ProseMirror]:!min-h-[140px]' : '[&_.ProseMirror]:!min-h-[160px]'
          }
        >
          <InputRTE
            key={currentId}
            name="details"
            includeControls={['formatting', 'link']}
            editorSize="sm"
            placeholder={`What did you think of ${current.modelName ?? 'this resource'}?`}
            hideToolbar
          />
        </Form>
        {shouldNudgeForComment({ recommended, comment }) && (
          <Text size="xs" c="yellow.6">
            Not for you? A sentence on what went wrong helps the creator and other users.
          </Text>
        )}
      </Stack>
    </Stack>
  );

  const footer = (
    <Group
      justify="space-between"
      p="md"
      // Site-wide floating buttons sit bottom-right above dialogs on phones.
      pr={isMobile ? 72 : undefined}
      className="shrink-0 border-0 border-t border-solid border-gray-3 dark:border-dark-4"
    >
      <Button variant="subtle" color="gray" onClick={advance} disabled={busy}>
        Skip
      </Button>
      <Group gap="xs">
        <Button variant="default" onClick={() => goTo(index - 1)} disabled={index === 0 || busy}>
          Back
        </Button>
        <Button onClick={saveAndNext} disabled={recommended == null} loading={busy}>
          {isLast ? 'Save & finish' : 'Save & next'}
        </Button>
      </Group>
    </Group>
  );

  if (isMobile)
    return (
      <Drawer
        opened={dialog.opened}
        onClose={dialog.onClose}
        zIndex={dialog.zIndex}
        position="bottom"
        size="90%"
        withCloseButton={false}
        styles={{
          content: { display: 'flex', flexDirection: 'column' },
          body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
        }}
      >
        <Group p="md" pb={0} gap="xs" wrap="nowrap">
          <Box className="min-w-0 flex-1">{picker}</Box>
          {closeButton}
        </Group>
        {body}
        {footer}
      </Drawer>
    );

  return (
    <Modal
      opened={dialog.opened}
      onClose={dialog.onClose}
      zIndex={dialog.zIndex}
      size={900}
      padding={0}
      radius="lg"
      centered
      withCloseButton={false}
    >
      <Group wrap="nowrap" align="stretch" gap={0} mih={480} mah="80dvh">
        {rail}
        <Divider orientation="vertical" />
        <Stack gap={0} className="min-w-0 flex-1">
          {body}
          {footer}
        </Stack>
      </Group>
    </Modal>
  );
}
