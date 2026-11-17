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
 * The "Report a bug" entry, shared by the Support menus and the floating help menu.
 *
 * `opened`: whether the surface showing it is open. The bug-report area is queried only then, and
 * only when signed in (the panel cannot accept a submission without a session). Until the answer is
 * in, or when the area is not collecting, it is the ticket portal link: shown rather than hidden so
 * no menu silently loses its bug path.
 */
export function useReportBugItem({ opened }: { opened: boolean }): SupportMenuItem {
  const currentUser = useCurrentUser();
  const { data: bugReportArea } = trpc.feedback.getArea.useQuery(
    { area: SITE_BUG_REPORT_AREA },
    { enabled: opened && !!currentUser }
  );
  const canReportInProduct = !!currentUser && !!bugReportArea?.enabled;
  return canReportInProduct
    ? {
        id: 'support-report-bug',
        label: 'Report a bug',
        icon: IconBug,
        onClick: () => dialogStore.trigger({ component: FeedbackDrawer }),
      }
    : {
        id: 'support-report-bug',
        label: 'Report a bug',
        icon: IconBug,
        href: SUPPORT_LINKS.bugTicket,
      };
}

/** The CivBot entry, or null when the assistant is not available to this user. */
export function useAssistantItem(): SupportMenuItem | null {
  const assistant = useAssistantAvailable();
  if (!assistant) return null;
  return {
    id: 'support-assistant',
    label: 'Get help fast',
    icon: IconMessageChatbot,
    onClick: () => useAssistantPanelStore.setState({ opened: true }),
  };
}

/**
 * One list for the footer Support menu and the user menu's Get help group, so the two cannot drift.
 */
export function useSupportMenuItems({ opened }: { opened: boolean }): SupportMenuItem[] {
  const reportBug = useReportBugItem({ opened });
  const assistant = useAssistantItem();

  const items: SupportMenuItem[] = [
    reportBug,
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
  if (assistant) items.push(assistant);
  items.push({
    id: 'support-portal',
    label: 'Support Portal',
    icon: IconLifebuoy,
    href: SUPPORT_LINKS.portal,
  });

  return items;
}
