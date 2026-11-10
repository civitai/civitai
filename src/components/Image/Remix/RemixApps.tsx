import { Text, ThemeIcon } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import {
  IconCamera,
  IconCube,
  IconLayoutGrid,
  IconGridDots,
  IconHorseToy,
  IconPalette,
  IconPencil,
  IconSparkles,
} from '@tabler/icons-react';
import { useOptionalCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { openRemixAppModal, openRemixAppPicker } from '~/components/Dialog/triggers/remix-app';
import { isPinKey, PinGlyph } from '~/components/AppLayout/AppHeader/UserMenuV2/UserMenuParts';
import { useRemixAppPins } from '~/components/Image/Remix/useRemixAppPins';
import { useRemixWorkflows } from '~/components/Image/Remix/useRemixRuns';
import { orderRemixMenuApps, recentRemixAppSlugs } from '~/shared/remix-apps/menu';
import { useMemo } from 'react';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { type RemixListedApp, useRemixAppList } from '~/components/Image/Remix/useRemixAppList';
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
  pick: IconLayoutGrid,
  palette: IconPalette,
};

export type RemixMenuApp = RemixListedApp;

/** The remix apps this viewer can run on this image: the same rule the server applies. */
export function useRemixApps(image: RemixSourceImage): RemixMenuApp[] {
  const features = useOptionalFeatureFlags();
  // The session's showNsfw, which the server reads too; `CurrentUser` leaves it out.
  const session = useOptionalCivitaiSessionContext();
  const apps = useRemixAppList();
  if (!features?.remixApps || session?.type !== 'authed') return [];
  const viewer = { isGreen: !!features.isGreen, showNsfw: !!session.showNsfw };
  return apps.filter(
    (app) =>
      app.enabled &&
      app.target === 'image.remix' &&
      !('refusal' in resolveRemixAppEngine(app, image, viewer))
  );
}

/** The section's quote, shared by the menu and the See more picker (same query, one fetch). */
export function useRemixAppPrices(imageId: number, enabled: boolean) {
  const quote = trpc.remixApp.quote.useQuery(
    { imageId },
    { enabled, staleTime: 3 * 60 * 1000, retry: false }
  );
  const prices = new Map(quote.data?.prices.map((p) => [p.slug, p]));
  return {
    loading: quote.isLoading,
    priceOf: (slug: string): RemixAppPrice | undefined =>
      quote.isError ? { refusal: PRICE_UNAVAILABLE } : prices.get(slug),
  };
}

export type RemixAppPrice = { cost: number } | { refusal: string };

export function RemixAppIcon({ icon }: { icon: string }) {
  const Icon = icons[icon] ?? IconSparkles;
  return (
    <ThemeIcon size={36} radius="md" variant="light" color="grape">
      <Icon size={20} stroke={1.7} />
    </ThemeIcon>
  );
}

export function openRemixApp(app: Pick<RemixMenuApp, 'slug' | 'name'>, imageId: number) {
  openRemixAppModal({ app: { slug: app.slug, name: app.name, runtime: true }, imageId });
}

function RemixAppItem({
  app,
  imageId,
  price,
  loading,
  onTogglePin,
  onRun,
}: {
  app: RemixMenuApp;
  imageId: number;
  price?: RemixAppPrice;
  loading: boolean;
  /** Set on a pinned row: unpins it. */
  onTogglePin?: () => void;
  onRun?: () => void;
}) {
  const refusal = price && 'refusal' in price ? price.refusal : undefined;
  const cost = price && 'cost' in price ? price.cost : undefined;

  return (
    <Menu.Item
      className="group rounded-md p-2"
      disabled={cost == null}
      aria-keyshortcuts={onTogglePin ? 'P' : undefined}
      onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
        if (!onTogglePin || !isPinKey(event)) return;
        event.preventDefault();
        onTogglePin();
      }}
      leftSection={<RemixAppIcon icon={app.icon} />}
      rightSection={
        <span className="flex items-center gap-1">
          {!refusal && (
            <CurrencyBadge currency="BUZZ" unitAmount={cost ?? 0} loading={loading} size="sm" />
          )}
          {onTogglePin && (
            <span
              // Not its own tab stop: the row is the menu item, and `P` unpins it from the keyboard.
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin();
              }}
              className="flex cursor-pointer items-center p-0.5"
              title="Unpin"
            >
              <PinGlyph pinned touch />
            </span>
          )}
        </span>
      }
      onClick={() => {
        onRun?.();
        openRemixApp(app, imageId);
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

/** Pinned apps, topped up with recently used ones, then the rest; See more lists them all. */
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
  const { loading, priceOf } = useRemixAppPrices(imageId, openCount > 0);
  const { pins, toggle, canEdit } = useRemixAppPins();
  // Mounted only while the menu is open, so a card that is merely rendered fetches nothing.
  const { data: workflows } = useRemixWorkflows();
  const recent = useMemo(() => recentRemixAppSlugs(workflows), [workflows]);
  const shown = orderRemixMenuApps({ apps, pinned: pins, recent });

  return (
    <>
      <Menu.Divider />
      <Menu.Label>Remix apps</Menu.Label>
      {shown.map((app) => (
        <RemixAppItem
          key={app.slug}
          app={app}
          imageId={imageId}
          price={priceOf(app.slug)}
          loading={loading}
          // Pinning is the picker's, so no hidden target on a touch screen pins by accident.
          onTogglePin={canEdit && pins.includes(app.slug) ? () => toggle(app.slug) : undefined}
          onRun={onRun}
        />
      ))}
      {/* Always: the picker is where apps are pinned, and where a pin on an unpriced row comes off. */}
      <Menu.Item
        className="rounded-md px-2 py-1.5"
        onClick={() => openRemixAppPicker({ apps, imageId, onRun })}
      >
        <Text size="sm" c="dimmed">
          See more
        </Text>
      </Menu.Item>
    </>
  );
}
