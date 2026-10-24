import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconBook,
  IconBrandDiscord,
  IconBug,
  IconLifebuoy,
  IconMessageChatbot,
  IconQuestionMark,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import { useAssistantAvailable } from '~/components/Assistant/useAssistantAvailable';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SUPPORT_LINKS } from '~/components/Support/support.constants';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SITE_BUG_REPORT_AREA } from '~/shared/constants/feedback.constants';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';
import { trpc } from '~/utils/trpc';

const FeedbackDrawer = dynamic(() => import('~/components/Feedback/FeedbackDrawer'), {
  ssr: false,
});

export type SupportMenuItem = {
  id:
    | 'support-report-bug'
    | 'support-education'
    | 'support-faq'
    | 'support-discord'
    | 'support-assistant'
    | 'support-portal';
  label: string;
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  /** External destination, opened in a new tab. */
  href?: string;
  onClick?: () => void;
};

/**
 * One list for the footer Support menu and the user menu's Get help group, so the two cannot drift.
 *
 * `opened`: whether the surface showing the items is open. The bug-report area is queried only
 * then, and only when signed in (the panel cannot accept a submission without a session).
 */
export function useSupportMenuItems({ opened }: { opened: boolean }): SupportMenuItem[] {
  const currentUser = useCurrentUser();
  const { data: bugReportArea } = trpc.feedback.getArea.useQuery(
    { area: SITE_BUG_REPORT_AREA },
    { enabled: opened && !!currentUser }
  );
  const canReportInProduct = !!currentUser && !!bugReportArea?.enabled;
  const assistant = useAssistantAvailable();

  const items: SupportMenuItem[] = [
    canReportInProduct
      ? {
          id: 'support-report-bug',
          label: 'Report a bug',
          icon: IconBug,
          onClick: () => dialogStore.trigger({ component: FeedbackDrawer }),
        }
      : // No session, or the area is not collecting: the ticket portal is the only honest
        // destination left. Shown rather than hidden so the menu never silently loses its bug path.
        {
          id: 'support-report-bug',
          label: 'Report a bug',
          icon: IconBug,
          href: SUPPORT_LINKS.bugTicket,
        },
    {
      id: 'support-education',
      label: 'Education Hub',
      icon: IconBook,
      href: SUPPORT_LINKS.educationHub,
    },
    { id: 'support-faq', label: 'FAQ', icon: IconQuestionMark, href: SUPPORT_LINKS.faq },
    {
      id: 'support-discord',
      label: 'Discord Community',
      icon: IconBrandDiscord,
      href: SUPPORT_LINKS.discord,
    },
  ];
  if (assistant)
    items.push({
      id: 'support-assistant',
      label: 'Get help fast',
      icon: IconMessageChatbot,
      onClick: () => useAssistantPanelStore.setState({ opened: true }),
    });
  items.push({
    id: 'support-portal',
    label: 'Support Portal',
    icon: IconLifebuoy,
    href: SUPPORT_LINKS.portal,
  });

  return items;
}
