import { Text, ThemeIcon } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import {
  IconCamera,
  IconCube,
  IconGridDots,
  IconHorseToy,
  IconPencil,
  IconSparkles,
} from '@tabler/icons-react';
import { useOptionalCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { openRemixAppModal } from '~/components/Dialog/triggers/remix-app';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { REMIX_MENU_APPS, type RemixMenuApp } from '~/shared/remix-apps/system-apps';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';
import { trpc } from '~/utils/trpc';

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

function RemixAppItem({
  app,
  imageId,
  price,
  loading,
  onRun,
}: {
  app: RemixMenuApp;
  imageId: number;
  price?: { cost: number } | { refusal: string };
  loading: boolean;
  onRun?: () => void;
}) {
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
        onRun?.();
        openRemixAppModal({
          app: { slug: app.slug, name: app.name, runtime: app.runtime },
          imageId,
        });
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
          onRun={onRun}
        />
      ))}
    </>
  );
}
