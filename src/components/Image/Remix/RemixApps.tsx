import { Checkbox, Menu, Stack, Text, ThemeIcon } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconCamera,
  IconCube,
  IconGridDots,
  IconHorseToy,
  IconPencil,
  IconSparkles,
} from '@tabler/icons-react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  SYSTEM_REMIX_APPS,
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
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
  if (!features?.remixApps) return [];
  return SYSTEM_REMIX_APPS.filter(
    (app) => !('refusal' in resolveRemixAppEngine(app, image, { isGreen: !!features.isGreen }))
  );
}

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
    showSuccessNotification({
      title: `${app.name} started`,
      message: (
        <Text size="sm">
          Added to your{' '}
          <Text component="span" c="blue.4" className="cursor-pointer" onClick={openQueue}>
            queue
          </Text>
        </Text>
      ),
      autoClose: 6000,
    });
  } catch (error) {
    showErrorNotification({ title: `${app.name} failed`, error: error as Error });
  }
}

export function runRemixApp({
  app,
  imageId,
  cost,
}: {
  app: RemixAppDefinition;
  imageId: number;
  cost?: number;
}) {
  // One nonce per tap: a repeated submit of the same tap names the same workflow.
  const nonce = crypto.randomUUID();
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

export function RemixAppItem({
  app,
  imageId,
  priced,
  onRun,
}: {
  app: RemixAppDefinition;
  imageId: number;
  /** Quote only once the menu is open, never on card render. */
  priced: boolean;
  onRun?: () => void;
}) {
  const quote = trpc.remixApp.quote.useQuery(
    { slug: app.slug, imageId },
    { enabled: priced, staleTime: 3 * 60 * 1000, retry: false }
  );
  const Icon = icons[app.icon] ?? IconSparkles;

  return (
    <Menu.Item
      className="rounded-md p-2"
      disabled={quote.isError}
      leftSection={
        <ThemeIcon size={36} radius="md" variant="light" color="grape">
          <Icon size={20} stroke={1.7} />
        </ThemeIcon>
      }
      rightSection={
        <CurrencyBadge
          currency="BUZZ"
          unitAmount={quote.data?.cost ?? 0}
          loading={quote.isLoading}
          size="sm"
        />
      }
      onClick={() => {
        onRun?.();
        runRemixApp({ app, imageId, cost: quote.data?.cost });
      }}
    >
      <Text size="sm" fw={600} lh={1.2}>
        {app.name}
      </Text>
      {quote.isError && (
        <Text size="xs" c="dimmed" lh={1.2}>
          {quote.error.message}
        </Text>
      )}
    </Menu.Item>
  );
}
