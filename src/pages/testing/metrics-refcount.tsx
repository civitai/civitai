import {
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { ElementInView, useElementInView } from '~/components/IntersectionObserver/ElementInView';
import { Metrics } from '~/components/Metrics';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import { useSignalTopicsStore } from '~/store/signal-topics.store';

const TEST_ENTITY_TYPE = 'Image' as const;
const DEFAULT_ENTITY_ID = 999999;
const ALT_ENTITY_ID = 999998;

export default function MetricsRefcountTest() {
  const [subscriberCount, setSubscriberCount] = useState(3);
  const [altSubscriberCount, setAltSubscriberCount] = useState(1);
  const [primaryEntityId, setPrimaryEntityId] = useState(DEFAULT_ENTITY_ID);
  const [primaryUseLive, setPrimaryUseLive] = useState(true);

  return (
    <Stack p="md" gap="md" maw={900} mx="auto">
      <Title>Metrics Refcount Test</Title>
      <Text size="sm" c="dimmed">
        Exercises duplicate-subscriber refcounting, single per-topic keep-alive, and{' '}
        <Code>useLive</Code> visibility gating. Works against the <Code>applyDelta</Code> pathway —
        no backend required.
      </Text>

      <ConsoleHelpReference />

      <SubscriptionStatus />

      <Card withBorder p="md">
        <Group justify="space-between">
          <div>
            <Title order={4}>Primary subscribers</Title>
            <Text size="sm" c="dimmed">
              Same <Code>entityType</Code>+<Code>entityId</Code> across all rows. All should receive
              updates; removing any subset leaves the rest unaffected.
            </Text>
          </div>
          <Group>
            <NumberInput
              label="Entity ID"
              value={primaryEntityId}
              onChange={(v) => typeof v === 'number' && setPrimaryEntityId(v)}
              w={140}
            />
          </Group>
        </Group>
        <Group mt="sm">
          <Button size="xs" onClick={() => setSubscriberCount((c) => c + 1)}>
            Add subscriber
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={subscriberCount === 0}
            onClick={() => setSubscriberCount((c) => Math.max(0, c - 1))}
          >
            Remove last
          </Button>
          <Button
            size="xs"
            color="blue"
            onClick={() =>
              useMetricSignalsStore
                .getState()
                .applyDelta(TEST_ENTITY_TYPE, primaryEntityId, { likeCount: 1 })
            }
          >
            +1 like
          </Button>
          <Button
            size="xs"
            color="pink"
            onClick={() =>
              useMetricSignalsStore
                .getState()
                .applyDelta(TEST_ENTITY_TYPE, primaryEntityId, { heartCount: 1 })
            }
          >
            +1 heart
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() =>
              useMetricSignalsStore.getState().clearDelta(TEST_ENTITY_TYPE, primaryEntityId)
            }
          >
            Clear deltas
          </Button>
          <Switch
            size="xs"
            checked={primaryUseLive}
            onChange={(e) => setPrimaryUseLive(e.currentTarget.checked)}
            label="useLive"
          />
        </Group>
        <Stack mt="md" gap="xs">
          {Array.from({ length: subscriberCount }, (_, i) => (
            <SubscriberRow key={i} index={i} entityId={primaryEntityId} useLive={primaryUseLive} />
          ))}
          {subscriberCount === 0 && (
            <Text size="sm" c="dimmed">
              (no subscribers — topic should drop out of <Code>__signals.getTopicRefs()</Code>)
            </Text>
          )}
        </Stack>
      </Card>

      <Card withBorder p="md">
        <div>
          <Title order={4}>Alternate entity — isolation check</Title>
          <Text size="sm" c="dimmed">
            Emitting a delta for entity <Code>{ALT_ENTITY_ID}</Code> should only affect this
            subscriber, not the primary rows above.
          </Text>
        </div>
        <Group mt="sm">
          <Button size="xs" onClick={() => setAltSubscriberCount((c) => c + 1)}>
            Add subscriber
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={altSubscriberCount === 0}
            onClick={() => setAltSubscriberCount((c) => Math.max(0, c - 1))}
          >
            Remove last
          </Button>
          <Button
            size="xs"
            color="blue"
            onClick={() =>
              useMetricSignalsStore
                .getState()
                .applyDelta(TEST_ENTITY_TYPE, ALT_ENTITY_ID, { likeCount: 1 })
            }
          >
            +1 like
          </Button>
        </Group>
        <Stack mt="md" gap="xs">
          {Array.from({ length: altSubscriberCount }, (_, i) => (
            <SubscriberRow key={i} index={i} entityId={ALT_ENTITY_ID} />
          ))}
        </Stack>
      </Card>

      <Card withBorder p="md">
        <Title order={4}>Visibility gating via ElementInView</Title>
        <Text size="sm" c="dimmed">
          Below is an <Code>{'<ElementInView>'}</Code> boundary; its child passes{' '}
          <Code>useLive={'{inView === true}'}</Code> to <Code>{'<Metrics>'}</Code>. Scroll the page
          so the boundary leaves the viewport and confirm the topic drops out of{' '}
          <Code>__signals.getTopicRefs()</Code>.
        </Text>
        <Divider my="md" />
        <Text size="sm" c="dimmed" ta="center">
          (spacer — scroll below)
        </Text>
        <div style={{ height: 1200 }} />
        <ElementInView>
          <GatedSubscriber entityId={primaryEntityId} />
        </ElementInView>
        <div style={{ height: 1200 }} />
      </Card>
    </Stack>
  );
}

function ConsoleHelpReference() {
  return (
    <Card withBorder p="md">
      <Title order={4}>Console helpers</Title>
      <Text size="sm" c="dimmed" mb="sm">
        Available on <Code>window.__signals</Code> in dev.
      </Text>
      <Code block>
        {`// inspect state
window.__signals.getTopicRefs()        // { "Metric:Image:999999": 3, ... }
window.__signals.getPendingRetries()   // { "Metric:Image:999999": { attempts: 2 } }
window.__signals.getLastConfirmed()    // { "Metric:Image:999999": { ageMs: 1234, at: "..." } }
window.__signals.getDeltas()           // { "Image:999999:likeCount": 2, ... }

// simulate hub pushes
window.__signals.emitMetric('Image', ${DEFAULT_ENTITY_ID}, { likeCount: 1 })
window.__signals.emitMetric('Image', ${DEFAULT_ENTITY_ID}, { heartCount: 5, laughCount: 1 })

// reset
window.__signals.clearDeltas('Image', ${DEFAULT_ENTITY_ID})`}
      </Code>
    </Card>
  );
}

function SubscriptionStatus() {
  const registeredTopics = useSignalTopicsStore((s) => s.registeredTopics);
  return (
    <Card withBorder p="md">
      <Title order={4}>Registered topics ({registeredTopics.length})</Title>
      <Stack gap={2} mt="xs">
        {registeredTopics.length === 0 ? (
          <Text size="sm" c="dimmed">
            (none)
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

function SubscriberRow({
  index,
  entityId,
  useLive = true,
}: {
  index: number;
  entityId: number;
  useLive?: boolean;
}) {
  return (
    <Card withBorder p="xs">
      <Group>
        <Text size="sm" fw={700} w={40}>
          #{index + 1}
        </Text>
        <Metrics
          entityType={TEST_ENTITY_TYPE}
          entityId={entityId}
          initial={{ likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 }}
          useLive={useLive}
        >
          {(m) => (
            <Group gap="xs">
              <Badge variant="light">likes: {m.likeCount ?? 0}</Badge>
              <Badge variant="light" color="pink">
                hearts: {m.heartCount ?? 0}
              </Badge>
              <Badge variant="light" color="yellow">
                laughs: {m.laughCount ?? 0}
              </Badge>
              <Badge variant="light" color="blue">
                cries: {m.cryCount ?? 0}
              </Badge>
            </Group>
          )}
        </Metrics>
      </Group>
    </Card>
  );
}

function GatedSubscriber({ entityId }: { entityId: number }) {
  const inView = useElementInView();
  const bg = inView === true ? 'var(--mantine-color-green-1)' : 'var(--mantine-color-red-1)';
  return (
    <Card withBorder p="sm" style={{ background: bg }}>
      <Group justify="space-between">
        <Text fw={700}>
          inView: <Code>{String(inView)}</Code> / useLive: <Code>{String(inView === true)}</Code>
        </Text>
        <Metrics
          entityType={TEST_ENTITY_TYPE}
          entityId={entityId}
          initial={{ likeCount: 0 }}
          useLive={inView === true}
        >
          {(m) => <Badge variant="filled">likes: {m.likeCount ?? 0}</Badge>}
        </Metrics>
      </Group>
    </Card>
  );
}
