import { Badge, Button, Card, Group, Skeleton, Stack, Text } from '@mantine/core';
import { IconSparkles, IconLeaf, IconPalette } from '@tabler/icons-react';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { abbreviateNumber } from '~/utils/number-helpers';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';

/**
 * ActiveCruciblesCarousel - Horizontal carousel of user's active crucibles
 *
 * Shows user's currently active crucibles with:
 * - Position badge (current rank)
 * - Prize pool
 * - Time remaining
 * - View and Submit buttons
 *
 * Only renders for authenticated users with at least one active crucible.
 * Reference: docs/features/crucible/mockups/discovery.html
 */
export function ActiveCruciblesCarousel() {
  const currentUser = useCurrentUser();

  // Only show for logged-in users
  if (!currentUser) return null;

  return <ActiveCruciblesCarouselContent />;
}

function ActiveCruciblesCarouselContent() {
  const { data: crucibles, isLoading } = trpc.crucible.getUserActiveCrucibles.useQuery({});

  // Don't show section if no active crucibles
  if (!isLoading && (!crucibles || crucibles.length === 0)) {
    return null;
  }

  return (
    <div className="mt-6">
      {/* Section header with count badge */}
      <Group gap="sm" mb="md">
        <Text fw={600} size="lg" c="white">
          Your Active Crucibles
        </Text>
        {isLoading ? (
          <Skeleton height={22} width={70} radius="xl" />
        ) : (
          <Badge
            size="sm"
            radius="xl"
            variant="light"
            color="green"
            styles={{ root: { textTransform: 'none' } }}
          >
            {crucibles?.length ?? 0} active
          </Badge>
        )}
      </Group>

      {/* Horizontal scrolling carousel */}
      <div
        className="flex gap-6 overflow-x-auto pb-4"
        style={{
          scrollBehavior: 'smooth',
          scrollbarWidth: 'thin',
          scrollbarColor: '#373a40 transparent',
        }}
      >
        {isLoading ? (
          // Loading skeletons
          <>
            <CrucibleCardSkeleton />
            <CrucibleCardSkeleton />
            <CrucibleCardSkeleton />
          </>
        ) : (
          crucibles?.map((crucible, index) => (
            <ActiveCrucibleCard
              key={crucible.id}
              crucible={crucible}
              colorVariant={index % 3}
            />
          ))
        )}
      </div>
    </div>
  );
}

type ActiveCrucibleCardProps = {
  crucible: {
    id: number;
    name: string;
    prizePool: number;
    timeRemaining: string;
    position: number | null;
    imageUrl: string | null;
  };
  colorVariant: number;
};

// Color variants for gradient backgrounds when no image
const gradientVariants = [
  'from-blue-600 to-blue-800',
  'from-green-600 to-green-700',
  'from-orange-500 to-orange-600',
];

const iconVariants = [IconSparkles, IconLeaf, IconPalette];

function ActiveCrucibleCard({ crucible, colorVariant }: ActiveCrucibleCardProps) {
  const GradientIcon = iconVariants[colorVariant % iconVariants.length];
  const gradientClass = gradientVariants[colorVariant % gradientVariants.length];

  return (
    <Card
      radius="md"
      className="flex-shrink-0 border border-[#373a40] transition-all hover:-translate-y-1 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-500/15"
      style={{
        width: '250px',
        minWidth: '250px',
        backgroundColor: '#25262b',
      }}
      p={0}
    >
      {/* Image area with position badge */}
      <div className="relative h-40 overflow-hidden">
        {crucible.imageUrl ? (
          <EdgeImage
            src={crucible.imageUrl}
            options={{ width: 300 }}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${gradientClass}`}
          >
            <GradientIcon size={40} className="text-white/90" />
          </div>
        )}

        {/* Position badge */}
        {crucible.position !== null && (
          <Badge
            className="absolute right-3 top-3"
            size="sm"
            variant="filled"
            color="dark"
            styles={{
              root: {
                backgroundColor: 'rgba(0, 0, 0, 0.7)',
                color: '#fbbf24',
                fontWeight: 700,
                textTransform: 'uppercase',
              },
            }}
          >
            #{crucible.position}
          </Badge>
        )}
      </div>

      {/* Card body */}
      <Stack gap="sm" p="lg" className="flex-1">
        {/* Title */}
        <Text
          fw={600}
          size="md"
          c="white"
          lineClamp={1}
          title={crucible.name}
        >
          {crucible.name}
        </Text>

        {/* Info grid */}
        <div className="mt-auto grid grid-cols-2 gap-4 border-t border-[#373a40] pt-4">
          <div className="flex flex-col gap-1">
            <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
              Prize Pool
            </Text>
            <Text fw={600} c="yellow" size="sm">
              {abbreviateNumber(crucible.prizePool)} Buzz
            </Text>
          </div>
          <div className="flex flex-col gap-1">
            <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
              Time Left
            </Text>
            <Text fw={600} c="blue.4" size="sm">
              {crucible.timeRemaining}
            </Text>
          </div>
        </div>

        {/* Action buttons */}
        <Group gap="xs" mt="sm">
          <Button
            component={Link}
            href={`/crucibles/${crucible.id}`}
            size="xs"
            variant="filled"
            color="blue"
            className="flex-1"
          >
            View
          </Button>
          <Button
            component={Link}
            href={`/crucibles/${crucible.id}?submit=true`}
            size="xs"
            variant="outline"
            color="blue"
            className="flex-1"
          >
            Submit
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function CrucibleCardSkeleton() {
  return (
    <Card
      radius="md"
      className="flex-shrink-0 border border-[#373a40]"
      style={{
        width: '250px',
        minWidth: '250px',
        backgroundColor: '#25262b',
      }}
      p={0}
    >
      <Skeleton height={160} radius={0} />
      <Stack gap="sm" p="lg">
        <Skeleton height={20} width="80%" />
        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[#373a40] pt-4">
          <Stack gap="xs">
            <Skeleton height={12} width={60} />
            <Skeleton height={16} width={80} />
          </Stack>
          <Stack gap="xs">
            <Skeleton height={12} width={50} />
            <Skeleton height={16} width={60} />
          </Stack>
        </div>
        <Group gap="xs" mt="sm">
          <Skeleton height={28} className="flex-1" />
          <Skeleton height={28} className="flex-1" />
        </Group>
      </Stack>
    </Card>
  );
}
