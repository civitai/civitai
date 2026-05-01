import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Grid,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import NumberFlow from '@number-flow/react';
import { useState } from 'react';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { CreatorCardSimple } from '~/components/CreatorCard/CreatorCardSimple';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useLiveMetricsEnabled } from '~/components/Metrics';
import { CustomNumberFlow } from '~/components/Metrics/CustomNumberFlow';
import { Metrics } from '~/components/Metrics/Metrics';
import { useSignalTopicsStore } from '~/store/signal-topics.store';
import type { ArticleGetAllRecord } from '~/server/services/article.service';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import { ArticleStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * Verifies that the migrated feed cards still receive live metric updates
 * after the `MetricSubscriptionProvider` removal and `<Metrics>` rollout.
 *
 * Uses mock data (hand-cast) so no DB state is required. Click the emit
 * buttons to simulate hub pushes; the relevant `AnimatedCount` on each card
 * should tick up and animate.
 */
export default function LiveCardParityTest() {
  const [articleId, setArticleId] = useState(900001);
  const [userId, setUserId] = useState(900002);
  const [imageId, setImageId] = useState(900003);
  const [cnfEntityId, setCnfEntityId] = useState(900004);

  const [articleMounted, setArticleMounted] = useState(true);
  const [creatorMounted, setCreatorMounted] = useState(true);
  const [articleDuplicate, setArticleDuplicate] = useState(false);
  const [creatorDuplicate, setCreatorDuplicate] = useState(false);

  return (
    <MasonryProvider columnWidth={320} maxColumnCount={1}>
      <ImagesProvider>
        <Stack p="md" gap="md" maw={1100} mx="auto">
          <Title>Live Card Parity Test</Title>
          <Text size="sm" c="dimmed">
            Each feed card below is mounted with mock data. Click the emit buttons to push deltas
            through <Code>useMetricSignalsStore.applyDelta</Code> — identical to what the live
            metric listener does when the hub pushes a message. The relevant{' '}
            <Code>AnimatedCount</Code> on each card should tick up and play its highlight animation.
          </Text>

          <FeatureFlagBanner />
          <SubscriptionStatus />

          <Grid gutter="md">
            <Grid.Col span={{ base: 12, md: 6 }}>
              <ArticleCardHarness
                id={articleId}
                setId={setArticleId}
                mounted={articleMounted}
                setMounted={setArticleMounted}
                duplicate={articleDuplicate}
                setDuplicate={setArticleDuplicate}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <CreatorCardHarness
                id={userId}
                setId={setUserId}
                mounted={creatorMounted}
                setMounted={setCreatorMounted}
                duplicate={creatorDuplicate}
                setDuplicate={setCreatorDuplicate}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <ImagesCardHarness id={imageId} setId={setImageId} />
            </Grid.Col>
            <Grid.Col span={{ base: 12 }}>
              <CustomNumberFlowHarness id={cnfEntityId} setId={setCnfEntityId} />
            </Grid.Col>
          </Grid>
        </Stack>
      </ImagesProvider>
    </MasonryProvider>
  );
}

function FeatureFlagBanner() {
  const enabled = useLiveMetricsEnabled();
  return (
    <Alert color={enabled ? 'green' : 'yellow'} variant="light">
      <Group justify="space-between">
        <Text component="span" size="sm">
          <Code>liveMetrics</Code> feature flag:{' '}
          <Badge color={enabled ? 'green' : 'yellow'} variant="filled">
            {enabled ? 'ON' : 'OFF'}
          </Badge>
        </Text>
        <Text size="sm" c="dimmed">
          {enabled
            ? 'Mounted cards should appear in Registered topics below.'
            : 'Cards should NOT subscribe; Registered topics should stay empty.'}
        </Text>
      </Group>
    </Alert>
  );
}

function SubscriptionStatus() {
  const registeredTopics = useSignalTopicsStore((s) => s.registeredTopics);
  return (
    <Card withBorder p="md">
      <Title order={5}>Registered topics ({registeredTopics.length})</Title>
      <Stack gap={2} mt="xs">
        {registeredTopics.length === 0 ? (
          <Text size="sm" c="dimmed">
            (none — all cards should be unmounted or feature flag off)
          </Text>
        ) : (
          registeredTopics.map((t) => (
            <Code key={t} block>
              {t}
            </Code>
          ))
        )}
      </Stack>
    </Card>
  );
}

type HarnessToggleProps = {
  mounted: boolean;
  setMounted: (v: boolean) => void;
  duplicate: boolean;
  setDuplicate: (v: boolean) => void;
};

function ArticleCardHarness({
  id,
  setId,
  mounted,
  setMounted,
  duplicate,
  setDuplicate,
}: { id: number; setId: (n: number) => void } & HarnessToggleProps) {
  const data = buildArticleMock(id);
  return (
    <HarnessCard
      title="ArticleCard"
      entityType="Article"
      entityId={id}
      setEntityId={setId}
      metrics={['commentCount', 'collectedCount', 'viewCount', 'tippedAmountCount']}
      mounted={mounted}
      setMounted={setMounted}
      duplicate={duplicate}
      setDuplicate={setDuplicate}
    >
      {mounted ? (
        <Stack gap="xs">
          <ArticleCard data={data} aspectRatio="landscape" />
          {duplicate && <ArticleCard data={data} aspectRatio="landscape" />}
        </Stack>
      ) : (
        <UnmountedPlaceholder />
      )}
    </HarnessCard>
  );
}

function CreatorCardHarness({
  id,
  setId,
  mounted,
  setMounted,
  duplicate,
  setDuplicate,
}: { id: number; setId: (n: number) => void } & HarnessToggleProps) {
  return (
    <HarnessCard
      title="CreatorCardSimple"
      entityType="User"
      entityId={id}
      setEntityId={setId}
      metrics={[
        'uploadCount',
        'followerCount',
        'thumbsUpCount',
        'downloadCount',
        'reactionCount',
        'generationCount',
      ]}
      mounted={mounted}
      setMounted={setMounted}
      duplicate={duplicate}
      setDuplicate={setDuplicate}
    >
      {mounted ? (
        <Stack gap="xs">
          <CreatorCardSimple user={{ id } as any} useEquippedCosmetics={false} />
          {duplicate && <CreatorCardSimple user={{ id } as any} useEquippedCosmetics={false} />}
        </Stack>
      ) : (
        <UnmountedPlaceholder />
      )}
    </HarnessCard>
  );
}

function UnmountedPlaceholder() {
  return (
    <Card withBorder p="sm" bg="gray.0">
      <Text size="sm" c="dimmed" ta="center">
        (card unmounted — topic should be gone from Registered topics)
      </Text>
    </Card>
  );
}

function CustomNumberFlowHarness({ id, setId }: { id: number; setId: (n: number) => void }) {
  const initial = {
    likeCount: 0,
    heartCount: 0,
    commentCount: 0,
    viewCount: 1234,
    collectedCount: 0,
    tippedAmountCount: 0,
  };
  return (
    <HarnessCard
      title="CustomNumberFlow vs NumberFlow (live deltas)"
      entityType="Image"
      entityId={id}
      setEntityId={setId}
      metrics={['likeCount', 'heartCount', 'commentCount', 'viewCount', 'collectedCount']}
    >
      <Text size="sm" c="dimmed" mb="xs">
        Both renderers are wired to the same <Code>Metrics</Code> subscription and apply the same
        deltas. Click the <Code>+1</Code> buttons above; rows should tick in lockstep — visually
        confirms <Code>CustomNumberFlow</Code> animates equivalently to <Code>NumberFlow</Code>.
      </Text>
      <Metrics entityType="Image" entityId={id} initial={initial}>
        {(metrics) => (
          <Grid gutter="xs">
            <Grid.Col span={4}>
              <Text size="xs" fw={600} c="dimmed">
                metric
              </Text>
            </Grid.Col>
            <Grid.Col span={4}>
              <Badge color="violet" variant="light" size="sm">
                CustomNumberFlow
              </Badge>
            </Grid.Col>
            <Grid.Col span={4}>
              <Badge color="gray" variant="light" size="sm">
                NumberFlow
              </Badge>
            </Grid.Col>
            {(Object.keys(initial) as (keyof typeof initial)[]).map((key) => {
              const v = metrics[key] ?? 0;
              return <CnfCompareRow key={key} label={key as string} value={v} />;
            })}
          </Grid>
        )}
      </Metrics>
    </HarnessCard>
  );
}

function CnfCompareRow({ label, value }: { label: string; value: number }) {
  return (
    <>
      <Grid.Col span={4}>
        <Code>{label}</Code>
      </Grid.Col>
      <Grid.Col span={4}>
        <Text size="xl" fw={600} ff="monospace">
          <CustomNumberFlow
            value={value}
            format={{ notation: 'compact', maximumFractionDigits: 1 }}
          />
        </Text>
      </Grid.Col>
      <Grid.Col span={4}>
        <Text size="xl" fw={600} ff="monospace">
          <NumberFlow value={value} format={{ notation: 'compact', maximumFractionDigits: 1 }} />
        </Text>
      </Grid.Col>
    </>
  );
}

function ImagesCardHarness({ id, setId }: { id: number; setId: (n: number) => void }) {
  // ImagesCard lives inside a more complex tree — ImagesProvider + MasonryProvider
  // above handle the missing context. We skip rendering it here because the reaction
  // flow is easier to verify via the Auction / Showcase surfaces; leaving a placeholder
  // row that still emits deltas so you can watch `window.__signals.getTopicRefs()` react.
  return (
    <HarnessCard
      title="Image metrics (delta-only, no card render)"
      entityType="Image"
      entityId={id}
      setEntityId={setId}
      metrics={['likeCount', 'heartCount', 'laughCount', 'cryCount', 'tippedAmountCount']}
    >
      <Text size="sm" c="dimmed">
        Mount an <Code>ImagesCard</Code> by opening a normal feed page with this entity id; emit
        deltas here and watch the live counts tick on that page. Included here for
        topic-registration parity checks only.
      </Text>
    </HarnessCard>
  );
}

function HarnessCard({
  title,
  entityType,
  entityId,
  setEntityId,
  metrics,
  mounted,
  setMounted,
  duplicate,
  setDuplicate,
  children,
}: {
  title: string;
  entityType: 'Image' | 'Article' | 'User' | 'Model' | 'ModelVersion';
  entityId: number;
  setEntityId: (n: number) => void;
  metrics: string[];
  mounted?: boolean;
  setMounted?: (v: boolean) => void;
  duplicate?: boolean;
  setDuplicate?: (v: boolean) => void;
  children: React.ReactNode;
}) {
  const emit = (metric: string) => {
    useMetricSignalsStore.getState().applyDelta(entityType, entityId, { [metric]: 1 } as any);
  };
  const clear = () => useMetricSignalsStore.getState().clearDelta(entityType, entityId);

  return (
    <Card withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>{title}</Title>
          <NumberInput
            size="xs"
            value={entityId}
            onChange={(v) => typeof v === 'number' && setEntityId(v)}
            w={120}
          />
        </Group>
        {(setMounted || setDuplicate) && (
          <Group gap="md">
            {setMounted && (
              <Switch
                size="xs"
                checked={mounted}
                onChange={(e) => setMounted(e.currentTarget.checked)}
                label="Mounted"
              />
            )}
            {setDuplicate && (
              <Switch
                size="xs"
                checked={duplicate}
                onChange={(e) => setDuplicate(e.currentTarget.checked)}
                label="Duplicate (same entityId)"
                disabled={!mounted}
              />
            )}
          </Group>
        )}
        <Group gap={4}>
          {metrics.map((m) => (
            <Button key={m} size="compact-xs" variant="default" onClick={() => emit(m)}>
              +1 {m}
            </Button>
          ))}
          <Button size="compact-xs" variant="subtle" onClick={clear}>
            Clear
          </Button>
        </Group>
        <div data-testid={`harness-slot-${entityType.toLowerCase()}`}>{children}</div>
      </Stack>
    </Card>
  );
}

// --------------------------------------------------------------------------
// Mock data builders — minimal required fields, cast to the real types.
// --------------------------------------------------------------------------

const MOCK_PUBLISHED_AT = new Date('2026-01-01T00:00:00Z');

function buildArticleMock(id: number): ArticleGetAllRecord {
  return {
    id,
    title: `Mock Article #${id}`,
    publishedAt: MOCK_PUBLISHED_AT,
    coverImage: {
      id,
      url: 'placeholder.jpg',
      type: MediaType.image,
      width: 800,
      height: 450,
      metadata: {},
      nsfwLevel: 1,
      hash: null,
      thumbnailUrl: null,
      name: null,
    },
    user: {
      id,
      username: `mock_user_${id}`,
      image: null,
      deletedAt: null,
      cosmetics: [],
      profilePicture: null,
    },
    tags: [],
    stats: {
      commentCount: 3,
      viewCount: 100,
      collectedCount: 7,
      tippedAmountCount: 0,
      favoriteCount: 0,
      likeCount: 0,
      dislikeCount: 0,
      heartCount: 0,
      laughCount: 0,
      cryCount: 0,
      commentCountAllTime: 3,
      viewCountAllTime: 100,
      collectedCountAllTime: 7,
      tippedAmountCountAllTime: 0,
    },
    status: ArticleStatus.Published,
    cosmetic: null,
    nsfw: false,
    nsfwLevel: 1,
    minor: false,
    poi: false,
    userNsfwLevel: 1,
  } as unknown as ArticleGetAllRecord;
}

// Reference the types so they're bundled; not all are used yet but helpful for
// when the harness expands.
export type _unused = ImagesInfiniteModel;
