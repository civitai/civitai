import { Checkbox, Menu, Stack, Text, ThemeIcon } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import {
  IconCamera,
  IconCheck,
  IconCube,
  IconGridDots,
  IconHorseToy,
  IconPencil,
  IconSparkles,
} from '@tabler/icons-react';
import { useRef } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  SYSTEM_REMIX_APPS,
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { showErrorNotification } from '~/utils/notifications';
import { trpc, trpcVanilla } from '~/utils/trpc';

const CONFIRMED_KEY = 'remix-apps:confirmed';

const icons: Record<string, typeof IconSparkles> = {
  sparkles: IconSparkles,
  camera: IconCamera,
  toy: IconHorseToy,
  grid: IconGridDots,
  pencil: IconPencil,
  clay: IconCube,
};

/** The remix apps this viewer can run on this image: the same rule the server applies. */
export function useRemixApps(image: RemixSourceImage): RemixAppDefinition[] {
  const features = useOptionalFeatureFlags();
  const currentUser = useCurrentUser();
  if (!features?.remixApps || !currentUser) return [];
  const viewer = { isGreen: !!features.isGreen, showNsfw: !!currentUser.showNsfw };
  return SYSTEM_REMIX_APPS.filter(
    (app) => !('refusal' in resolveRemixAppEngine(app, image, viewer))
  );
}

// Plain localStorage rather than a hook: the confirm runs after the menu item has unmounted.
function hasConfirmed() {
  try {
    return localStorage.getItem(CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberConfirmed() {
  try {
    localStorage.setItem(CONFIRMED_KEY, '1');
  } catch {
    // Private mode: the confirm simply shows again next time.
  }
}

function openQueue() {
  generationGraphPanel.open(undefined, { preserveEntryAction: true });
  generationGraphPanel.setView('queue');
}

/** Outside React: the menu, and the item that called this, unmount as soon as it is clicked. */
async function submitRemixApp(app: RemixAppDefinition, imageId: number, nonce: string) {
  try {
    await trpcVanilla.remixApp.run.mutate({ slug: app.slug, imageId, nonce });
    showNotification({
      icon: <IconCheck size={18} />,
      color: 'teal',
      title: `${app.name} started`,
      message: 'Added to your queue. Click to open it.',
      className: 'cursor-pointer',
      onClick: openQueue,
      autoClose: 6000,
    });
  } catch (error) {
    showErrorNotification({ title: `${app.name} failed`, error: error as Error });
  }
}

/**
 * `nonce` names this tap: the server derives the workflow's externalId from it, so a repeated
 * submit of the same tap makes one workflow.
 */
export function runRemixApp({
  app,
  imageId,
  cost,
  nonce,
}: {
  app: RemixAppDefinition;
  imageId: number;
  cost?: number;
  nonce: string;
}) {
  if (hasConfirmed()) return submitRemixApp(app, imageId, nonce);

  let dontAskAgain = false;
  openConfirmModal({
    title: app.name,
    children: (
      <Stack gap="sm">
        <Text size="sm">
          {cost != null
            ? `Runs ${
                app.name
              } on this image for ${cost.toLocaleString()} Buzz and adds the result to your queue.`
            : `Runs ${app.name} on this image and adds the result to your queue.`}
        </Text>
        <Checkbox
          label="Don't ask again"
          onChange={(e) => {
            dontAskAgain = e.currentTarget.checked;
          }}
        />
      </Stack>
    ),
    labels: { confirm: 'Run', cancel: 'Cancel' },
    onConfirm: () => {
      if (dontAskAgain) rememberConfirmed();
      submitRemixApp(app, imageId, nonce);
    },
  });
}

function RemixAppItem({
  app,
  imageId,
  price,
  loading,
  onRun,
}: {
  app: RemixAppDefinition;
  imageId: number;
  price?: { cost: number } | { refusal: string };
  loading: boolean;
  onRun?: () => void;
}) {
  // One nonce per menu open: the dropdown remounts on every open, so a second click during the
  // close animation repeats this tap instead of starting a new one.
  const nonce = useRef(crypto.randomUUID()).current;
  const Icon = icons[app.icon] ?? IconSparkles;
  const refusal = price && 'refusal' in price ? price.refusal : undefined;
  const cost = price && 'cost' in price ? price.cost : undefined;

  return (
    <Menu.Item
      className="rounded-md p-2"
      disabled={!!refusal}
      leftSection={
        <ThemeIcon size={36} radius="md" variant="light" color="grape">
          <Icon size={20} stroke={1.7} />
        </ThemeIcon>
      }
      rightSection={
        !refusal && (
          <CurrencyBadge currency="BUZZ" unitAmount={cost ?? 0} loading={loading} size="sm" />
        )
      }
      onClick={() => {
        onRun?.();
        runRemixApp({ app, imageId, cost, nonce });
      }}
    >
      <Text size="sm" fw={600} lh={1.2}>
        {app.name}
      </Text>
      {refusal && (
        <Text size="xs" c="dimmed" lh={1.2}>
          {refusal}
        </Text>
      )}
    </Menu.Item>
  );
}

export function RemixAppsSection({
  apps,
  imageId,
  priced,
  onRun,
}: {
  apps: RemixAppDefinition[];
  imageId: number;
  /** Quote only once the menu is open, never on card render. */
  priced: boolean;
  onRun?: () => void;
}) {
  const quote = trpc.remixApp.quote.useQuery(
    { imageId },
    { enabled: priced, staleTime: 3 * 60 * 1000, retry: false }
  );
  const prices = new Map(quote.data?.prices.map((p) => [p.slug, p]));

  return (
    <>
      <Menu.Divider />
      <Menu.Label>Remix apps</Menu.Label>
      {apps.map((app) => (
        <RemixAppItem
          key={app.slug}
          app={app}
          imageId={imageId}
          price={quote.isError ? { refusal: quote.error.message } : prices.get(app.slug)}
          loading={quote.isLoading}
          onRun={onRun}
        />
      ))}
    </>
  );
}
