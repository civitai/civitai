import { Text, Tooltip } from '@mantine/core';
import clsx from 'clsx';
import { IconMessageReport } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { buildAppsStoreFeedbackContext } from '~/components/Apps/appsStoreFeedbackContext';
import { parseAppsStoreFilters } from '~/components/Apps/appsStoreQueryParams';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useFeedbackSubmission } from '~/components/Feedback/useFeedbackSubmission';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const FeedbackDrawer = dynamic(() => import('~/components/Feedback/FeedbackDrawer'), {
  ssr: false,
});

const APPS_FEEDBACK_AREA = 'apps-marketplace';

/**
 * The `/apps` feedback prompt, as a small notice at the foot of the Discover rail. "Give
 * feedback" opens the same side panel as "Report a bug"; a collapsed rail shows only the icon.
 *
 * Renders nothing unless the viewer is signed in and `feedback-area-apps-marketplace` is on for
 * them, the same conditions the inline prompt used.
 */
export function AppsFeedbackNotice({ collapsed }: { collapsed: boolean }) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { areaEnabled } = useFeedbackSubmission({
    area: APPS_FEEDBACK_AREA,
    enabled: !!currentUser,
  });

  if (!currentUser || !areaEnabled) return null;

  const open = () =>
    dialogStore.trigger({
      component: FeedbackDrawer,
      props: {
        area: APPS_FEEDBACK_AREA,
        // The view the report is about, read from the URL at click time. The search box only
        // echoes into the URL after its 300ms debounce, so a click mid-keystroke carries the
        // previous term, which is also what the grid shows.
        context: buildAppsStoreFeedbackContext({
          filters: parseAppsStoreFilters(router.query),
          path: window.location.pathname,
        }),
        title: 'Give feedback',
        intro: 'Apps are new here. If something is missing or looks off, tell us.',
        placeholder:
          'What were you trying to do? Missing apps, broken listings, confusing pages, anything.',
        submitLabel: 'Send feedback',
        closeLabel: 'Close feedback',
      },
    });

  // The same box as a rail nav item (`AppsRailNav`): full width, same padding, same radius, same
  // icon colour, so the button lines up with the links above it instead of reading as a pill.
  const button = (
    <button
      type="button"
      onClick={open}
      aria-label={collapsed ? 'Give feedback' : undefined}
      data-testid={collapsed ? 'apps-feedback-notice' : 'apps-feedback-button'}
      className={clsx(
        'flex w-full items-center rounded py-2 text-sm font-medium text-dark-7 transition-colors hover:bg-gray-1 dark:text-gray-4 dark:hover:bg-dark-5',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-3'
      )}
    >
      <IconMessageReport size={18} className="text-gray-6 dark:text-dark-2" />
      {!collapsed && <span className="flex-1 text-left">Give feedback</span>}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip label="Give feedback" position="right" withArrow>
        {button}
      </Tooltip>
    );
  }

  return (
    <div
      className="mt-1 flex flex-col gap-2 border-t border-gray-3 pt-3 dark:border-dark-4"
      data-testid="apps-feedback-notice"
    >
      <Text size="xs" c="dimmed" className="px-3">
        Apps are new here. If something&apos;s missing or looks off, tell us.
      </Text>
      {button}
    </div>
  );
}
