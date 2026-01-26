import { Button, Container, Paper, Progress, Stack, Text, Title } from '@mantine/core';
import { openConfirmModal, closeAllModals } from '@mantine/modals';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { IconGavel, IconUpload, IconBook, IconPencil, IconX } from '@tabler/icons-react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client';
import { slugit } from '~/utils/string-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CrucibleHeader } from '~/components/Crucible/CrucibleHeader';
import { CrucibleLeaderboard } from '~/components/Crucible/CrucibleLeaderboard';
import { CrucibleEntryGrid } from '~/components/Crucible/CrucibleEntryGrid';
import { parsePrizePositions } from '~/components/Crucible/CruciblePrizeBreakdown';
import { CrucibleStatus, Currency } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { formatDate } from '~/utils/date-helpers';
import type { Prisma } from '@prisma/client';
import { openCrucibleSubmitEntryModal } from '~/components/Dialog/triggers/crucible-submit-entry';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const querySchema = z.object({
  id: z.coerce.number(),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.crucible) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.crucible.getById.prefetch({ id: result.data.id });
    }

    return { props: removeEmpty(result.data) };
  },
});

function CrucibleDetailPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const { data: crucible, isLoading } = trpc.crucible.getById.useQuery({ id });
  const { data: judgesData } = trpc.crucible.getJudgesCount.useQuery(
    { crucibleId: id },
    { enabled: !!id }
  );

  // Cancel mutation for moderators
  const cancelMutation = trpc.crucible.cancel.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        title: 'Crucible Cancelled',
        message: `Successfully cancelled. ${
          result.refundedEntries
        } entries refunded (${result.totalRefunded.toLocaleString()} Buzz total).`,
      });
      // Invalidate the query to refetch the crucible data
      queryUtils.crucible.getById.invalidate({ id });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to cancel crucible',
        error: new Error(error.message),
      });
    },
  });

  if (isLoading) return <PageLoader />;
  if (!crucible) return <NotFound />;

  const judgesCount = judgesData?.count ?? 0;

  const prizePositions = parsePrizePositions(crucible.prizePositions);
  const entryCount = crucible._count?.entries ?? 0;
  const totalPrizePool = crucible.entryFee * entryCount;
  const isActive = crucible.status === CrucibleStatus.Active;
  const isPending = crucible.status === CrucibleStatus.Pending;
  const canSubmitEntries = isActive || isPending;
  const canJudge = isActive;

  // User entries info
  const userEntryCount =
    currentUser && crucible.entries
      ? crucible.entries.filter((e) => e.userId === currentUser.id).length
      : 0;
  const maxUserEntries = crucible.entryLimit ?? 5;
  const userEntryProgress = (userEntryCount / maxUserEntries) * 100;

  // Parse allowed resources if present
  const allowedResources = crucible.allowedResources as Prisma.JsonValue;

  // Moderator-only: check if crucible can be cancelled
  const isModerator = currentUser?.isModerator ?? false;
  const canCancel =
    isModerator &&
    crucible.status !== CrucibleStatus.Completed &&
    crucible.status !== CrucibleStatus.Cancelled;

  // Handle cancel action with confirmation dialog
  const handleCancelCrucible = () => {
    openConfirmModal({
      title: 'Cancel Crucible',
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Are you sure you want to cancel this crucible? This action cannot be undone.
          </Text>
          <Text size="sm" c="dimmed">
            All entry fees ({entryCount} entries × {crucible.entryFee.toLocaleString()} Buzz ={' '}
            {totalPrizePool.toLocaleString()} Buzz total) will be refunded to participants.
          </Text>
        </Stack>
      ),
      centered: true,
      closeOnConfirm: false,
      labels: { cancel: 'Keep it', confirm: 'Cancel Crucible' },
      confirmProps: { color: 'red', loading: cancelMutation.isPending },
      onConfirm: async () => {
        try {
          await cancelMutation.mutateAsync({ id });
          closeAllModals();
        } catch {
          // Error handled by mutation onError callback
        }
      },
    });
  };

  return (
    <>
      <Meta
        title={`${crucible.name} | Civitai Crucible`}
        description={crucible.description ?? undefined}
        links={[
          {
            href: `${env.NEXT_PUBLIC_BASE_URL}/crucibles/${crucible.id}/${slugit(crucible.name)}`,
            rel: 'canonical',
          },
        ]}
      />
      <SensitiveShield contentNsfwLevel={crucible.nsfwLevel}>
        {/* Hero Section */}
        <CrucibleHeader
          crucible={{
            id: crucible.id,
            name: crucible.name,
            description: crucible.description,
            status: crucible.status,
            nsfwLevel: crucible.nsfwLevel,
            entryFee: crucible.entryFee,
            endAt: crucible.endAt,
            user: crucible.user,
            image: crucible.image,
            _count: crucible._count,
          }}
        />

        {/* Main Content */}
        <Container size="xl" className="py-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_340px]">
            {/* Left Column - Main Content */}
            <div>
              {/* Stats Grid */}
              <div className="mb-6 grid grid-cols-3 gap-4">
                <StatBox value={entryCount.toString()} label="Entries" />
                <StatBox value={abbreviateNumber(judgesCount)} label="Judges" />
                <StatBox
                  value={crucible.endAt ? getTimeRemaining(crucible.endAt, crucible.status) : '-'}
                  label="Time Left"
                />
              </div>

              {/* CTA Button - Start Judging */}
              {canJudge && (
                <Button
                  size="xl"
                  fullWidth
                  leftSection={<IconGavel size={24} />}
                  className="mb-8"
                  styles={{
                    root: {
                      background: 'linear-gradient(135deg, #228be6 0%, #40c057 100%)',
                      boxShadow: '0 8px 24px rgba(34, 139, 230, 0.3)',
                      fontWeight: 600,
                      fontSize: '1.125rem',
                      padding: '1.25rem 2.5rem',
                      transition: 'all 300ms',
                      '&:hover': {
                        background: 'linear-gradient(135deg, #1c7ec0 0%, #37b24d 100%)',
                        transform: 'translateY(-2px)',
                        boxShadow: '0 12px 32px rgba(34, 139, 230, 0.4)',
                      },
                    },
                  }}
                  onClick={() => router.push(`/crucibles/${crucible.id}/judge`)}
                >
                  Start Judging Now
                </Button>
              )}

              {/* Entry Grid with User Entries section */}
              <CrucibleEntryGrid
                entries={crucible.entries.map((e) => ({
                  ...e,
                  user: {
                    ...e.user,
                    deletedAt: null,
                  },
                }))}
                title="All Entries"
                showUserEntries={!!currentUser}
                currentUserId={currentUser?.id}
                maxUserEntries={maxUserEntries}
              />
            </div>

            {/* Right Column - Sidebar */}
            <div className="flex flex-col gap-6">
              {/* Your Entries Panel */}
              {canSubmitEntries && (
                <Paper className="rounded-lg p-6" bg="dark.6">
                  <Title
                    order={5}
                    className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white"
                  >
                    <IconPencil size={16} />
                    Your Entries
                  </Title>

                  <Button
                    variant="filled"
                    fullWidth
                    leftSection={<IconUpload size={16} />}
                    className="mb-4"
                    styles={{
                      root: {
                        background: 'linear-gradient(135deg, #228be6 0%, #40c057 100%)',
                        fontWeight: 600,
                        transition: 'all 300ms',
                        '&:hover': {
                          background: 'linear-gradient(135deg, #1c7ec0 0%, #37b24d 100%)',
                        },
                        '&:disabled': {
                          background: 'rgba(201, 203, 207, 0.1)',
                          color: 'var(--mantine-color-dimmed)',
                        },
                      },
                    }}
                    onClick={() => {
                      openCrucibleSubmitEntryModal({
                        crucibleId: crucible.id,
                        crucibleName: crucible.name,
                        entryFee: crucible.entryFee,
                        entryLimit: maxUserEntries,
                        nsfwLevel: crucible.nsfwLevel,
                        currentEntryCount: userEntryCount,
                      });
                    }}
                    disabled={!currentUser}
                  >
                    Submit Entry
                  </Button>

                  <div className="mb-4 border-b border-[#373a40] pb-4">
                    <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
                      Entry Fee
                    </Text>
                    <CurrencyBadge
                      currency={Currency.BUZZ}
                      unitAmount={crucible.entryFee}
                      size="md"
                      fw={600}
                    />
                  </div>

                  {currentUser && (
                    <div>
                      <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
                        Your Entries
                      </Text>
                      <Text size="sm" fw={600} c="white" mb={8}>
                        {userEntryCount} of {maxUserEntries} used
                      </Text>
                      <Progress
                        value={userEntryProgress}
                        size={6}
                        radius="sm"
                        styles={{
                          root: {
                            backgroundColor: 'rgba(201, 203, 207, 0.1)',
                          },
                          section: {
                            background: 'linear-gradient(90deg, #228be6 0%, #40c057 100%)',
                          },
                        }}
                      />
                    </div>
                  )}
                </Paper>
              )}

              {/* Prize Pool & Leaderboard */}
              <CrucibleLeaderboard
                entries={crucible.entries.map((e) => ({
                  ...e,
                  user: {
                    ...e.user,
                  },
                }))}
                prizePositions={prizePositions}
                totalPrizePool={totalPrizePool}
              />

              {/* Rules & Requirements */}
              <Paper className="rounded-lg p-6" bg="dark.6">
                <Title
                  order={5}
                  className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white"
                >
                  <IconBook size={16} />
                  Rules & Requirements
                </Title>

                <div className="flex flex-col gap-3">
                  {/* NSFW Level */}
                  <RuleItem
                    label="Content Levels"
                    content={<ContentLevelBadges nsfwLevel={crucible.nsfwLevel} />}
                  />

                  {/* Deadline */}
                  {crucible.endAt && (
                    <RuleItem
                      label="Deadline"
                      content={formatDate(crucible.endAt, undefined, true)}
                    />
                  )}

                  {/* Entry Limit */}
                  <RuleItem label="Max Entries Per User" content={`${maxUserEntries} entries`} />

                  {/* Total Entry Cap */}
                  {crucible.maxTotalEntries && (
                    <RuleItem label="Total Entry Cap" content={`${crucible.maxTotalEntries} max`} />
                  )}

                  {/* Judging */}
                  <RuleItem label="Judging" content="Continuous & Live" />

                  {/* Tie-Breaking */}
                  <RuleItem
                    label="Tie-Breaking"
                    content="Earlier entries rank higher in case of tied scores"
                  />
                </div>
              </Paper>

              {/* Moderator Actions - Cancel Button */}
              {canCancel && (
                <Paper className="rounded-lg border border-red-500/30 p-6" bg="dark.6">
                  <Title
                    order={5}
                    className="mb-4 flex items-center gap-2 uppercase tracking-wider text-red-400"
                  >
                    <IconX size={16} />
                    Moderator Actions
                  </Title>

                  <Button
                    variant="outline"
                    color="red"
                    fullWidth
                    leftSection={<IconX size={16} />}
                    onClick={handleCancelCrucible}
                    loading={cancelMutation.isPending}
                  >
                    Cancel Crucible
                  </Button>

                  <Text size="xs" c="dimmed" mt="sm">
                    Cancelling will refund all entry fees to participants.
                  </Text>
                </Paper>
              )}
            </div>
          </div>
        </Container>
      </SensitiveShield>
    </>
  );
}

// Helper components

function StatBox({ value, label }: { value: string; label: string }) {
  return (
    <Paper className="rounded-lg p-4 text-center" bg="dark.6">
      <Text className="text-2xl font-bold text-white">{value}</Text>
      <Text size="xs" c="dimmed" tt="uppercase" className="tracking-wider" mt={4}>
        {label}
      </Text>
    </Paper>
  );
}

function RuleItem({ label, content }: { label: string; content: React.ReactNode }) {
  return (
    <div className="text-xs text-gray-400">
      <span className="mr-2 text-blue-500">•</span>
      <Text component="span" fw={600} c="white">
        {label}:
      </Text>{' '}
      {typeof content === 'string' ? content : content}
    </div>
  );
}

function ContentLevelBadges({ nsfwLevel }: { nsfwLevel: number }) {
  const levels = [];
  if (nsfwLevel >= 1) levels.push('PG');
  if (nsfwLevel >= 2) levels.push('PG-13');
  if (nsfwLevel >= 4) levels.push('R');
  if (nsfwLevel >= 8) levels.push('X');
  if (nsfwLevel >= 16) levels.push('XXX');

  // If no restrictions or very low NSFW level, show PG
  if (levels.length === 0) levels.push('PG');

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {levels.map((level) => (
        <span
          key={level}
          className="rounded-full border border-blue-500/30 bg-blue-500/20 px-3 py-1 text-xs font-semibold text-blue-400"
        >
          {level}
        </span>
      ))}
    </div>
  );
}

function getTimeRemaining(endAt: Date, status: CrucibleStatus): string {
  if (status === CrucibleStatus.Completed || status === CrucibleStatus.Cancelled) {
    return 'Ended';
  }

  const now = new Date();
  const end = new Date(endAt);
  const diff = end.getTime() - now.getTime();

  if (diff <= 0) return 'Ended';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export default Page(CrucibleDetailPage);
