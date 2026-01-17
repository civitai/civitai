import { Badge, Button, Card, Group, Skeleton, Stack, Text } from '@mantine/core';
import { IconFlame, IconLogin, IconInfoCircle, IconStar } from '@tabler/icons-react';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';
import { abbreviateNumber } from '~/utils/number-helpers';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';

/**
 * FeaturedCrucibleHero - Large hero card for featured/promoted crucible
 *
 * Displays the featured crucible (highest prize pool active crucible) prominently:
 * - 2-column layout: gradient image on left, content on right
 * - "Paid Placement" badge (placeholder for future sponsored content)
 * - Title and description
 * - Stats: Prize Pool (gold), Time Remaining, Entries
 * - Two CTAs: "Enter Competition" and "Learn More"
 *
 * Reference: docs/features/crucible/mockups/discovery.html
 */
export function FeaturedCrucibleHero() {
  const { data: featured, isLoading } = trpc.crucible.getFeatured.useQuery({});

  if (isLoading) {
    return <FeaturedCrucibleHeroSkeleton />;
  }

  // Don't show if no featured crucible
  if (!featured) {
    return null;
  }

  return <FeaturedCrucibleHeroContent featured={featured} />;
}

type FeaturedCrucibleData = {
  id: number;
  name: string;
  description: string;
  prizePool: number;
  timeRemaining: string;
  entriesCount: number;
  imageUrl: string | null;
};

function FeaturedCrucibleHeroContent({ featured }: { featured: FeaturedCrucibleData }) {
  return (
    <Card
      radius="md"
      className="mb-8 overflow-hidden border border-[#373a40] transition-all hover:border-blue-500 hover:shadow-lg hover:shadow-blue-500/20"
      style={{
        background: 'linear-gradient(135deg, #373a40 0%, #25262b 100%)',
      }}
      p={0}
    >
      <div className="grid grid-cols-1 md:grid-cols-2">
        {/* Image area */}
        <div className="relative min-h-[200px] overflow-hidden md:min-h-[300px]">
          {featured.imageUrl ? (
            <EdgeImage
              src={featured.imageUrl}
              options={{ width: 800 }}
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <div
              className="flex size-full items-center justify-center bg-gradient-to-br from-blue-500 to-blue-700"
              style={{ position: 'relative', overflow: 'hidden' }}
            >
              {/* Animated background pattern */}
              <div
                className="absolute inset-0 opacity-10"
                style={{
                  backgroundImage:
                    'radial-gradient(circle, rgba(255,255,255,0.3) 1px, transparent 1px)',
                  backgroundSize: '50px 50px',
                }}
              />
              <IconFlame size={64} className="text-white/90" />
            </div>
          )}
        </div>

        {/* Content area */}
        <div className="flex min-h-[300px] flex-col justify-between p-6 md:p-8">
          <div>
            {/* Paid Placement badge */}
            <Badge
              size="md"
              radius="sm"
              leftSection={<IconStar size={14} />}
              styles={{
                root: {
                  backgroundColor: 'rgba(251, 191, 36, 0.15)',
                  color: '#fbbf24',
                  textTransform: 'none',
                  fontWeight: 600,
                  marginBottom: '1rem',
                },
              }}
            >
              Paid Placement
            </Badge>

            {/* Title */}
            <Text fz="xl" fw={700} c="white" mb="xs" className="md:text-2xl">
              {featured.name}
            </Text>

            {/* Description */}
            <Text c="dimmed" size="sm" lineClamp={3} className="leading-relaxed">
              {featured.description}
            </Text>
          </div>

          {/* Stats grid */}
          <div className="my-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatItem
              label="Prize Pool"
              value={`${abbreviateNumber(featured.prizePool)} Buzz`}
              highlight
            />
            <StatItem label="Time Remaining" value={featured.timeRemaining} />
            <StatItem label="Entries" value={String(featured.entriesCount)} />
          </div>

          {/* Action buttons */}
          <Group gap="md">
            <Button
              component={Link}
              href={`/crucibles/${featured.id}`}
              size="md"
              leftSection={<IconLogin size={18} />}
              className="bg-blue-600 hover:bg-blue-500"
            >
              Enter Competition
            </Button>
            <Button
              component={Link}
              href={`/crucibles/${featured.id}`}
              size="md"
              variant="outline"
              color="blue"
              leftSection={<IconInfoCircle size={18} />}
            >
              Learn More
            </Button>
          </Group>
        </div>
      </div>
    </Card>
  );
}

type StatItemProps = {
  label: string;
  value: string;
  highlight?: boolean;
};

function StatItem({ label, value, highlight }: StatItemProps) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        {label}
      </Text>
      <Text fz="xl" fw={700} c={highlight ? 'yellow' : 'white'} className="md:text-2xl">
        {value}
      </Text>
    </Stack>
  );
}

function FeaturedCrucibleHeroSkeleton() {
  return (
    <Card
      radius="md"
      className="mb-8 overflow-hidden border border-[#373a40]"
      style={{
        background: 'linear-gradient(135deg, #373a40 0%, #25262b 100%)',
      }}
      p={0}
    >
      <div className="grid grid-cols-1 md:grid-cols-2">
        {/* Image area skeleton */}
        <Skeleton height={300} radius={0} />

        {/* Content area skeleton */}
        <Stack gap="md" p="xl" className="min-h-[300px]">
          <Skeleton height={28} width={140} radius="sm" />
          <Skeleton height={32} width="80%" />
          <Skeleton height={60} width="100%" />

          <div className="my-4 grid grid-cols-3 gap-4">
            <Stack gap="xs">
              <Skeleton height={12} width={80} />
              <Skeleton height={28} width={100} />
            </Stack>
            <Stack gap="xs">
              <Skeleton height={12} width={100} />
              <Skeleton height={28} width={80} />
            </Stack>
            <Stack gap="xs">
              <Skeleton height={12} width={60} />
              <Skeleton height={28} width={50} />
            </Stack>
          </div>

          <Group gap="md" mt="auto">
            <Skeleton height={42} width={160} />
            <Skeleton height={42} width={130} />
          </Group>
        </Stack>
      </div>
    </Card>
  );
}
