import { Checkbox, Stack, Text, ThemeIcon } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
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
import { getQueryKey } from '@trpc/react-query';
import { useMemo } from 'react';
import { useOptionalCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { REMIX_MENU_APPS, type RemixMenuApp } from '~/shared/remix-apps/system-apps';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc, trpcVanilla } from '~/utils/trpc';

export const CONFIRMED_KEY = 'remix-apps:confirmed';

/** A failed or rate-limited quote; the menu re-quotes when it opens again. */
const PRICE_UNAVAILABLE = 'Price unavailable. Reopen the menu to try again.';

const icons: Record<string, typeof IconSparkles> = {
  sparkles: IconSparkles,
  camera: IconCamera,
  toy: IconHorseToy,
  grid: IconGridDots,
  pencil: IconPencil,
  clay: IconCube,
};

/** The remix apps this viewer can run on this image: the same rule the server applies. */
export function useRemixApps(image: RemixSourceImage): RemixMenuApp[] {
  const features = useOptionalFeatureFlags();
  // The session's showNsfw, which the server reads too; `CurrentUser` leaves it out.
  const session = useOptionalCivitaiSessionContext();
  if (!features?.remixApps || session?.type !== 'authed') return [];
  const viewer = { isGreen: !!features.isGreen, showNsfw: !!session.showNsfw };
  return REMIX_MENU_APPS.filter((app) => !('refusal' in resolveRemixAppEngine(app, image, viewer)));
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
async function submitRemixApp(
  app: RunnableRemixApp,
  imageId: number,
  cost: number,
  nonce: string,
  startedMessage = 'Added to your queue. Click to open it.'
) {
  try {
    if (app.runtime)
      await trpcVanilla.remixApp.start.mutate({ slug: app.slug, imageId, nonce, quote: cost });
    else await trpcVanilla.remixApp.run.mutate({ slug: app.slug, imageId, nonce });
    // The queue's status signals skip a workflow it has never listed, so it must refetch.
    queryClient
      .invalidateQueries({
        queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
        exact: false,
      })
      .catch(() => null);
    showNotification({
      icon: <IconCheck size={18} />,
      color: 'teal',
      title: `${app.name} started`,
      message: startedMessage,
      className: 'cursor-pointer',
      onClick: openQueue,
      autoClose: 6000,
    });
  } catch (error) {
    showErrorNotification({ title: `${app.name} failed`, error: error as Error });
  }
}

type RunnableRemixApp = Pick<RemixMenuApp, 'slug' | 'name'> & { runtime?: boolean };

/**
 * `nonce` names this tap: the server derives the workflow's externalId from it, so a repeated
 * submit of the same tap makes one workflow.
 */
export function runRemixApp({
  app,
  imageId,
  cost,
  nonce,
  startedMessage,
  onSettled,
}: {
  app: RunnableRemixApp;
  imageId: number;
  /** The quoted price: nothing runs, confirmed or not, without one on screen. */
  cost: number;
  nonce: string;
  startedMessage?: string;
  /** After the submit returns or fails, or the confirm is dismissed. */
  onSettled?: () => void;
}) {
  const submit = () => submitRemixApp(app, imageId, cost, nonce, startedMessage).finally(onSettled);
  if (hasConfirmed()) return submit();

  let dontAskAgain = false;
  let confirmed = false;
  openConfirmModal({
    title: app.name,
    children: (
      <Stack gap="sm">
        <Text size="sm">
          {`Runs ${
            app.name
          } on this image for ${cost.toLocaleString()} Buzz and adds the result to your queue.`}
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
    // Any dismissal (cancel, escape, outside click); a confirm settles when its submit does.
    onClose: () => {
      if (!confirmed) onSettled?.();
    },
    onConfirm: () => {
      confirmed = true;
      if (dontAskAgain) rememberConfirmed();
      submit();
    },
  });
}

function RemixAppItem({
  app,
  imageId,
  price,
  loading,
  openCount,
  onRun,
}: {
  app: RemixMenuApp;
  imageId: number;
  openCount: number;
  price?: { cost: number } | { refusal: string };
  loading: boolean;
  onRun?: () => void;
}) {
  // One nonce per menu open, not per mount: a click while the menu is still closing, or after a
  // quick reopen, can land on this same mounted item.
  const nonce = useMemo(() => crypto.randomUUID(), [openCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const Icon = icons[app.icon] ?? IconSparkles;
  const refusal = price && 'refusal' in price ? price.refusal : undefined;
  const cost = price && 'cost' in price ? price.cost : undefined;

  return (
    <Menu.Item
      className="rounded-md p-2"
      disabled={cost == null}
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
        if (cost == null) return;
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
  openCount,
  onRun,
}: {
  apps: RemixMenuApp[];
  imageId: number;
  /** How many times the menu has opened; 0 means never, and nothing is quoted. */
  openCount: number;
  onRun?: () => void;
}) {
  const quote = trpc.remixApp.quote.useQuery(
    { imageId },
    { enabled: openCount > 0, staleTime: 3 * 60 * 1000, retry: false }
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
          price={quote.isError ? { refusal: PRICE_UNAVAILABLE } : prices.get(app.slug)}
          loading={quote.isLoading}
          openCount={openCount}
          onRun={onRun}
        />
      ))}
    </>
  );
}
