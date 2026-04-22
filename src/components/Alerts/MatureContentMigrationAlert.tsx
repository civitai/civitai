import { useCallback, useRef } from 'react';
import { Button, CloseButton, Text, ThemeIcon } from '@mantine/core';
import { IconArrowRight, IconPepper } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { syncAccount } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';

const ALERT_ID = 'mature-content-migration';

export function MatureContentMigrationAlert() {
  const { isGreen } = useFeatureFlags();
  const serverDomains = useServerDomains();
  const { data: session } = useSession();
  const { data: settings } = trpc.user.getSettings.useQuery();
  const isDismissed = (settings?.dismissedAlerts ?? []).includes(ALERT_ID);

  // Check the raw session user preferences (before domain override).
  // On green, the BrowserSettingsProvider forces showNsfw=false, so we
  // need the original values to know if the user would see NSFW elsewhere.
  const user = session?.user;
  const hasNsfwEnabled =
    user?.showNsfw && Flags.intersects(user.browsingLevel, nsfwBrowsingLevelsFlag);

  const utils = trpc.useUtils();
  const dismissMutation = trpc.user.dismissAlert.useMutation({
    onMutate: async () => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: [...(old?.dismissedAlerts ?? []), ALERT_ID],
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
  });

  // Spotlight effect — ref + direct DOM to avoid re-renders on mouse move
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(300px circle at ${x}px ${y}px, rgba(239,68,68,0.08), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  if (!isGreen || !hasNsfwEnabled || !settings || isDismissed) return null;

  const redDomain = serverDomains.red;
  const redUrl = syncAccount(`//${redDomain}`);

  const handleDismiss = () => dismissMutation.mutate({ alertId: ALERT_ID });

  return (
    <div className="container mb-3">
      <div
        className="relative overflow-hidden rounded-lg border border-red-9/30 bg-gradient-to-r from-red-9/15 via-red-9/5 to-transparent"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Spotlight glow — styled via ref to avoid re-renders */}
        <div
          ref={spotlightRef}
          className="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={{ opacity: 0 }}
        />

        <div className="relative flex items-center gap-4 px-4 py-3">
          <ThemeIcon variant="light" color="red" size="lg" radius="xl" className="shrink-0">
            <IconPepper size={20} />
          </ThemeIcon>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
            <Text size="sm" className="text-gray-2">
              <span className="font-semibold text-red-4">Mature content</span> now lives at{' '}
              <Text
                component="a"
                href={redUrl}
                target="_blank"
                rel="noreferrer nofollow"
                size="sm"
                fw={700}
                className="text-red-4 underline decoration-red-4/40 underline-offset-2 transition-colors hover:text-red-3 hover:decoration-red-3"
              >
                civitai.red
              </Text>{' '}
              &mdash; same account, same Buzz, new home.
            </Text>

            <Button
              component="a"
              href={redUrl}
              target="_blank"
              rel="noreferrer nofollow"
              color="red"
              variant="outline"
              size="compact-sm"
              radius="xl"
              rightSection={<IconArrowRight size={14} />}
              className="shrink-0"
            >
              Explore civitai.red
            </Button>
          </div>

          <CloseButton
            size="sm"
            variant="subtle"
            color="gray"
            radius="xl"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="shrink-0"
          />
        </div>
      </div>
    </div>
  );
}
