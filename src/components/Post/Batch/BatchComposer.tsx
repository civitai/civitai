import { Alert, Button, Center, Container, Group, Select, Text, Title } from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import { IconArrowLeft, IconInfoCircle, IconLock } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduleIssue } from '@civitai/shared/post-scheduling';
import {
  POST_BATCH_MAX_IMAGES,
  POST_BATCH_MIN_GAP_MINUTES,
  seededRng,
  utcDayKey,
} from '@civitai/shared/post-scheduling';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BackButton } from '~/components/BackButton/BackButton';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  FileUploadProvider,
  useFileUploadContext,
} from '~/components/FileUpload/FileUploadProvider';
import { MediaUploadSettingsProvider } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import ImageSelectModal from '~/components/Training/Form/ImageSelectModal';
import type { SelectedImage } from '~/components/Training/Form/ImageSelectModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import { useCatchNavigation } from '~/store/catch-navigation.store';
import { formatDate } from '~/utils/date-helpers';
import { downloadGeneratorImages } from '~/utils/generator-import';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import type { BatchComposerStore } from './batch-composer.store';
import {
  BatchComposerStoreContext,
  createBatchComposerStore,
  useBatchComposerStore,
} from './batch-composer.store';
import { clearDraft, useDraftPersistence } from './batch-composer.draft';
import type { PlannedPost } from './batch-composer.utils';
import {
  defaultTitleTemplate,
  describeCadence,
  fixSpacing,
  promotedFromResource,
} from './batch-composer.utils';
import { BatchMediaGrid } from './BatchMediaGrid';
import { SavePresetButton } from './BatchPresets';
import type { DroppedFile } from './BatchMediaGrid';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';
import { BatchProgressModal } from './BatchProgressModal';
import { BatchReviewTable } from './BatchReviewTable';
import { BatchSharedMetadata, rememberShared } from './BatchSharedMetadata';
import { BatchSummaryRail } from './BatchSummaryRail';
import type { PreviewView } from './SchedulePreview';
import { dayElementId } from './SchedulePreview';
import { ScheduleBuilder } from './ScheduleBuilder';
import { useBatchPlan, useBatchScheduleValidation } from './useBatchSchedule';

export type BatchComposerProps = {
  modelId?: number;
  modelVersionId?: number | null;
  /** Where the schedule starts when the planner's quick-add opened the composer. */
  startAt?: Date | null;
};

export function BatchComposer({ modelId, modelVersionId, startAt }: BatchComposerProps) {
  const currentUser = useCurrentUser();
  const [store] = useState<BatchComposerStore>(() =>
    createBatchComposerStore({
      promotedVersionId: modelVersionId ?? null,
      titleTemplate: defaultTitleTemplate(!!modelVersionId),
      startAt,
    })
  );
  useDraftPersistence(store, currentUser?.id);

  if (currentUser?.muted)
    return (
      <Container size="xs">
        <Center p="xl">
          <AlertWithIcon color="yellow" icon={<IconLock />} iconSize={32} iconColor="yellow">
            <Text size="md">You cannot create posts because your account has been restricted.</Text>
          </AlertWithIcon>
        </Center>
      </Container>
    );

  return (
    <BatchComposerStoreContext.Provider value={store}>
      <MediaUploadSettingsProvider settings={{ maxItems: POST_BATCH_MAX_IMAGES }}>
        <FileUploadProvider>
          <ComposerBody modelId={modelId} modelVersionId={modelVersionId ?? undefined} />
        </FileUploadProvider>
      </MediaUploadSettingsProvider>
    </BatchComposerStoreContext.Provider>
  );
}

function ComposerBody({ modelId, modelVersionId }: { modelId?: number; modelVersionId?: number }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [media, shared, seed, screen, addMedia, setFixedDates, openReview] = useBatchComposerStore(
    (state) => [
      state.media,
      state.shared,
      state.seed,
      state.screen,
      state.addMedia,
      state.setFixedDates,
      state.openReview,
    ]
  );
  const fileUploadContext = useFileUploadContext();
  const trackedFiles = fileUploadContext?.[0] ?? [];
  const uploading = trackedFiles.filter((x) => x.status === 'pending' || x.status === 'uploading');

  const { data: model, isLoading: modelLoading } = trpc.model.getById.useQuery(
    { id: modelId ?? 0 },
    { enabled: !!modelId && !modelVersionId }
  );
  const { data: version } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId ?? 0 },
    { enabled: !!modelVersionId }
  );
  const [promotedVersionId, promotedNames, hydrated, setPromoted] = useBatchComposerStore(
    (state) => [
      state.shared.promotedVersionId,
      state.promotedNames,
      state.hydrated,
      state.setPromoted,
    ]
  );
  // The query's version wins over whatever the draft held; re-applied once the draft is in.
  useEffect(() => {
    if (!modelVersionId) return;
    setPromoted(
      version
        ? { id: modelVersionId, model: version.model.name, version: version.name }
        : { id: modelVersionId }
    );
  }, [modelVersionId, version, hydrated, setPromoted]);
  const names = useMemo(
    () => ({ model: promotedNames?.model ?? null, version: promotedNames?.version ?? null }),
    [promotedNames]
  );
  const promoted = useMemo(
    () =>
      promotedVersionId
        ? {
            id: promotedVersionId,
            label: promotedNames ? `${promotedNames.model} ${promotedNames.version}` : 'Loading…',
            locked: !!modelVersionId,
          }
        : null,
    [promotedVersionId, promotedNames, modelVersionId]
  );
  const unavailableReason = describeUnavailable(
    version ? { status: version.status, model: version.model } : model ?? null
  );
  const publishedVersions = model?.modelVersions.filter(
    (candidate) => candidate.status === ModelStatus.Published
  );

  const [skippedCount, setSkippedCount] = useState(0);
  const { canAdd, upload, error, loading } = useMediaUpload({
    count: media.length,
    onComplete: (props) => addMedia(props),
  });
  const handleDrop = useCallback(
    (files: DroppedFile[]) => {
      if (currentUser?.muted) return;
      const room = POST_BATCH_MAX_IMAGES - media.length;
      setSkippedCount(Math.max(0, files.length - room));
      void upload(files.slice(0, Math.max(0, room)));
    },
    [currentUser?.muted, media.length, upload]
  );
  const openGeneratorImport = () => {
    dialogStore.trigger({
      component: ImageSelectModal,
      props: {
        title: 'Import from Generator',
        selectSource: 'generation',
        importedUrls: media.map((x) => x.url),
        videoAllowed: true,
        onSelect: async (assets: SelectedImage[]) => {
          if (!assets.length) return;
          const id = `batch-import-${Date.now()}`;
          showNotification({
            id,
            loading: true,
            autoClose: false,
            withCloseButton: false,
            message: `Importing ${assets.length} from the generator…`,
          });
          const files = await downloadGeneratorImages(assets);
          if (files.length) handleDrop(files);
          setTimeout(() => hideNotification(id), 500);
        },
      },
    });
  };

  const plan = useBatchPlan(names);
  const validation = useBatchScheduleValidation(plan.dates, {
    enabled: screen === 'edit' && plan.dates.length > 0,
  });

  const submittedRef = useRef(false);
  const uploadingRef = useRef(0);
  uploadingRef.current = uploading.length;
  const leavePredicate = useCallback(() => !submittedRef.current && uploadingRef.current > 0, []);
  useCatchNavigation({
    name: 'batch-composer',
    message: 'Uploads are still running and would be lost. Leave anyway?',
    predicate: leavePredicate,
  });

  const failedCount = media.filter((x) => x.status === 'error').length;
  const blockedCount = media.filter((x) => x.status === 'blocked').length;
  const totals = {
    uploaded: media.length,
    eligible: plan.uploaded.length,
    posts: plan.postCount,
    excluded: failedCount + blockedCount,
  };
  const first = plan.dates[0] ?? null;
  const last = plan.dates[plan.dates.length - 1] ?? null;
  const [schedule] = useBatchComposerStore((state) => [state.schedule]);
  const cadence = describeCadence(schedule, plan.dates);

  const [fixSummary, setFixSummary] = useState<string | null>(null);
  const [highlightDay, setHighlightDay] = useState<string | null>(null);
  const [previewView, setPreviewView] = useState<PreviewView>('strips');
  const canFixSpacing = validation.issues.some(
    (issue) => issue.code === 'gap' || issue.code === 'cap'
  );
  const handleFixSpacing = () => {
    const { dates, moved } = fixSpacing({
      dates: plan.dates,
      existing: validation.existing,
      dailyLimit: validation.dailyLimit ?? Number.POSITIVE_INFINITY,
      now: new Date(),
      rng: seededRng(seed + 1),
    });
    setFixedDates(dates);
    const newLast = dates.reduce((max, date) => (date > max ? date : max), dates[0]);
    setFixSummary(
      moved
        ? `Moved ${moved} ${moved === 1 ? 'post' : 'posts'}, last is now ${formatDate(
            newLast,
            'MMM D'
          )}`
        : 'Nothing needed moving.'
    );
  };
  const handleIssueClick = (issue: ScheduleIssue) => {
    const day =
      issue.day ??
      (issue.index !== undefined && plan.dates[issue.index]
        ? utcDayKey(plan.dates[issue.index])
        : null);
    if (!day) return;
    setPreviewView('strips');
    setHighlightDay(day);
    requestAnimationFrame(() =>
      document
        .getElementById(dayElementId(day))
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    );
  };

  const reviewDisabledReason = !plan.postCount
    ? 'Add media first'
    : uploading.length
    ? 'Wait for uploads to finish'
    : failedCount
    ? `${failedCount} upload${
        failedCount === 1 ? '' : 's'
      } failed. Retry or remove them to continue.`
    : plan.generationIssue
    ? plan.generationIssue
    : validation.checking
    ? 'Checking your existing schedule…'
    : !validation.ok
    ? `Fix ${validation.issues.length} ${
        validation.issues.length === 1 ? 'conflict' : 'conflicts'
      } to continue`
    : null;

  const handleReview = () => {
    rememberShared(shared, currentUser?.id);
    openReview(plan.posts);
  };

  const backUrl = modelId
    ? getModelUrl({ modelId, modelName: version?.model.name ?? model?.name, modelVersionId })
    : '/';

  if (screen === 'review')
    return (
      <ReviewScreen
        promotedLabel={promoted?.label ?? null}
        viewScheduledHref={
          currentUser ? `/user/${currentUser.username}/posts?section=draft&scheduled=true` : '/'
        }
        calendarHref={features.postPlanner ? '/user/schedule' : null}
        onSubmitted={() => {
          submittedRef.current = true;
        }}
        onDone={() => {
          if (currentUser) void clearDraft(currentUser.id);
        }}
      />
    );

  const railProps = {
    totals,
    first,
    last,
    cadence,
    issues: validation.issues,
    checking: validation.checking && plan.dates.length > 0,
    dailyLimit: validation.dailyLimit,
    perDay: validation.perDay,
    posts: plan.posts,
    onIssueClick: handleIssueClick,
    highlightDay,
    canFixSpacing,
    onFixSpacing: handleFixSpacing,
    fixSummary,
    onReview: handleReview,
    reviewDisabledReason,
    view: previewView,
    onViewChange: setPreviewView,
  };

  return (
    <Container size="xl" className="flex flex-col gap-4 pb-20 lg:pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BackButton url={backUrl} />
          <Title order={2}>Schedule a batch of posts</Title>
        </div>
        {promoted && (
          <Text size="sm" c="dimmed">
            Promoting:{' '}
            <Text component="span" td="underline">
              {promoted.label}
            </Text>
          </Text>
        )}
      </div>
      {unavailableReason && (
        <Alert color="red" variant="light" icon={<IconInfoCircle size={18} />}>
          {unavailableReason}
        </Alert>
      )}
      <Alert
        color="blue"
        variant="light"
        icon={<IconInfoCircle size={18} />}
        title={promoted ? `How a batch promotes ${promoted.label}` : 'How a batch promotes a model'}
      >
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          <li>
            {promoted
              ? 'Every post is attributed to this version and lists it as a resource, so anyone who likes an image can open and use the model from it.'
              : 'Pick a model version and every post is attributed to it, listing it as a resource so anyone who likes an image can open and use the model from it.'}
          </li>
          <li>
            Posts go live one at a time over days or weeks instead of in one burst, so your images
            keep showing up in feeds and in the model&apos;s gallery for as long as the schedule
            runs.
          </li>
          <li>
            Each post counts toward your daily limit on the day it goes live, and you can move or
            unschedule any of them from the planner.
          </li>
        </ul>
      </Alert>
      {unavailableReason ? null : (
        <>
          {publishedVersions && (
            <Select
              description="Select a version so every post is attributed to it"
              placeholder="Select a version"
              value={modelVersionId ? String(modelVersionId) : null}
              nothingFoundMessage={modelLoading ? 'Loading…' : 'No published versions'}
              data={publishedVersions.map(({ id, name }) => ({
                label: name,
                value: id.toString(),
              }))}
              onChange={(value) =>
                router.replace({ query: { ...router.query, modelVersionId: value } }, undefined, {
                  shallow: true,
                })
              }
              maw={400}
            />
          )}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex flex-col gap-8">
              <Section number={1} title="Media">
                <BatchMediaGrid
                  onDrop={handleDrop}
                  onImport={openGeneratorImport}
                  canAdd={canAdd && !currentUser?.muted}
                  error={error}
                  loading={loading}
                  uploading={uploading}
                  skippedCount={skippedCount}
                />
              </Section>
              <Section
                number={2}
                title="Apply to every post"
                disabledReason={plan.uploaded.length ? null : 'Add media first'}
                action={
                  features.postPresets && <SavePresetButton disabled={!plan.uploaded.length} />
                }
              >
                <BatchSharedMetadata
                  disabled={!plan.uploaded.length}
                  promoted={promoted}
                  onPromotedChange={(resource) =>
                    setPromoted(resource ? promotedFromResource(resource) : null)
                  }
                  titlePreviews={plan.posts.slice(0, 2).map((post) => post.title ?? 'Untitled')}
                />
              </Section>
              <Section
                number={3}
                title="Schedule"
                disabledReason={plan.uploaded.length ? null : 'Add media first'}
              >
                <ScheduleBuilder
                  disabled={!plan.uploaded.length}
                  generationIssue={plan.generationIssue}
                />
              </Section>
            </div>
            <BatchSummaryRail variant="desktop" {...railProps} />
          </div>
          <BatchSummaryRail variant="mobile" {...railProps} />
        </>
      )}
    </Container>
  );
}

/** Why the queried model or version cannot be promoted, mirroring `assertCanUseModelVersion`. */
function describeUnavailable(
  target: {
    status: ModelStatus;
    model?: { status: ModelStatus; mode?: ModelModifier | null };
    mode?: ModelModifier | null;
  } | null
): string | null {
  if (!target) return null;
  const model = target.model ?? target;
  if (model.mode === ModelModifier.TakenDown)
    return 'This model has been taken down, so it cannot be promoted.';
  if (model.mode === ModelModifier.Archived)
    return 'This model is archived, so it cannot be promoted.';
  if (model.status !== ModelStatus.Published)
    return 'This model is not published. Publish it first: scheduling or publishing a model moves every pending post on it to the release date, which would undo a spread-out batch.';
  if (target.model && target.status !== ModelStatus.Published)
    return 'This version is not published yet. Publish it first: scheduling or publishing a version moves every pending post on it to the release date, which would undo a spread-out batch.';
  return null;
}

function Section({
  number,
  title,
  disabledReason,
  action,
  children,
}: {
  number: number;
  title: string;
  disabledReason?: string | null;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`batch-section-${number}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-blue-5 text-xs font-bold text-white">
            {number}
          </span>
          <Title order={4} id={`batch-section-${number}`} className="uppercase tracking-wide">
            {title}
          </Title>
          {disabledReason && (
            <Text size="xs" c="dimmed">
              {disabledReason}
            </Text>
          )}
        </div>
        <div className="flex min-h-[28px] items-center">{action}</div>
      </div>
      {children}
    </section>
  );
}

function ReviewScreen({
  promotedLabel,
  viewScheduledHref,
  calendarHref,
  onSubmitted,
  onDone,
}: {
  promotedLabel: string | null;
  viewScheduledHref: string;
  calendarHref: string | null;
  onSubmitted: () => void;
  onDone: () => void;
}) {
  const [
    reviewPlan,
    shared,
    closeReview,
    updateReviewPost,
    removeReviewPost,
    markSubmitted,
    reset,
  ] = useBatchComposerStore((state) => [
    state.reviewPlan,
    state.shared,
    state.closeReview,
    state.updateReviewPost,
    state.removeReviewPost,
    state.markSubmitted,
    state.reset,
  ]);
  const posts = useMemo(() => reviewPlan ?? [], [reviewPlan]);
  const dates = useMemo(() => posts.map((post) => post.publishedAt), [posts]);
  const [submitting, setSubmitting] = useState<PlannedPost[] | null>(null);
  // While posts are being created, every one already written counts as "existing" on the server
  // and would collide with its own pending twin, so the preview stops re-validating.
  const validation = useBatchScheduleValidation(dates, {
    enabled: posts.length > 0 && !submitting,
  });
  const [hardFailure, setHardFailure] = useState<string | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const issueByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of validation.issues) {
      if (issue.index !== undefined && posts[issue.index])
        map.set(posts[issue.index].key, issue.message);
      else if (issue.day)
        posts
          .filter((post) => utcDayKey(post.publishedAt) === issue.day)
          .forEach((post) => map.set(post.key, issue.message));
    }
    return map;
  }, [validation.issues, posts]);

  const submitDisabledReason = !posts.length
    ? 'Nothing left to schedule'
    : validation.checking
    ? 'Checking your schedule…'
    : !validation.ok
    ? `Fix ${validation.issues.length} ${
        validation.issues.length === 1 ? 'conflict' : 'conflicts'
      } to continue`
    : null;

  const handleSubmit = () => {
    const first = posts[0]?.publishedAt;
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: `Schedule ${posts.length} ${posts.length === 1 ? 'post' : 'posts'}?`,
        message: `The first goes live ${
          first ? formatDate(first, 'ddd MMM D, h:mm A') : 'soon'
        }. You can move or unschedule any of them from your posts.`,
        labels: { confirm: 'Schedule', cancel: 'Cancel' },
        onConfirm: () => {
          setHardFailure(null);
          onSubmitted();
          setSubmitting(posts.map((post) => ({ ...post })));
        },
      },
    });
  };

  const sharedLine = [
    promotedLabel,
    ...shared.resources.map((resource) => `${resource.model.name} ${resource.name}`),
    ...shared.tools.map((tool) => tool.name),
    ...shared.techniques.map((technique) => technique.name),
    ...shared.tags.map((tag) => `#${tag}`),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Container size="xl" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Title order={2}>
          Review {posts.length} {posts.length === 1 ? 'post' : 'posts'}
        </Title>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={closeReview}>
            Back to edit
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!!submitDisabledReason}
            data-testid="batch-schedule-button"
          >
            Schedule {posts.length} {posts.length === 1 ? 'post' : 'posts'}
          </Button>
        </Group>
      </div>
      <Text size="sm" c={submitDisabledReason ? 'red' : 'dimmed'}>
        {submitDisabledReason ??
          `All times are in your local time zone (${timeZone}).${
            validation.dailyLimit !== null ? ` Daily limit: ${validation.dailyLimit}` : ''
          } · gap ${
            validation.minGapMinutes ?? POST_BATCH_MIN_GAP_MINUTES
          } min. Days count in UTC.`}
      </Text>
      {hardFailure && (
        <Alert
          color="red"
          title="Nothing was created"
          withCloseButton
          onClose={() => setHardFailure(null)}
        >
          {hardFailure}
        </Alert>
      )}
      <BatchReviewTable
        posts={posts}
        issueByKey={issueByKey}
        onTitleChange={(key, title) => updateReviewPost(key, { title })}
        onTimeChange={(key, publishedAt) => updateReviewPost(key, { publishedAt })}
        onRemove={removeReviewPost}
      />
      {sharedLine && (
        <Text size="sm" c="dimmed">
          Shared: {sharedLine}
        </Text>
      )}
      {submitting && (
        <BatchProgressModal
          posts={submitting}
          payload={{
            modelVersionId: shared.promotedVersionId,
            tags: shared.tags,
            tools: shared.tools.map((tool) => tool.id),
            techniques: shared.techniques.map((technique) => technique.id),
            extraResourceIds: shared.resources.map((resource) => resource.id),
          }}
          viewScheduledHref={viewScheduledHref}
          calendarHref={calendarHref}
          onCreated={(keys) => keys.forEach((key) => removeReviewPost(key))}
          onHardFailure={(message) => {
            setSubmitting(null);
            setHardFailure(message);
          }}
          onDone={() => {
            markSubmitted();
            onDone();
          }}
          onScheduleAnother={() => {
            setSubmitting(null);
            reset();
          }}
          onKeepEditing={() => setSubmitting(null)}
        />
      )}
    </Container>
  );
}
