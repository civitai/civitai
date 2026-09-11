import { Button, Menu } from '@mantine/core';
import {
  IconBook,
  IconBrandDiscord,
  IconBug,
  IconLifebuoy,
  IconMessageChatbot,
  IconQuestionMark,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
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

const ICON_SIZE = 16;

/**
 * The footer support button.
 *
 * It used to open a modal whose four cards all ended at the ticket portal or an
 * external site; the menu is the same set of destinations minus that interstitial,
 * with "Report a bug" rewired to the in-product feedback panel so a report arrives
 * with the reporter's Faro session attached instead of as a ticket someone has to
 * chase. The modal itself is untouched and still serves `/support`.
 */
export function SupportMenu() {
  const currentUser = useCurrentUser();
  const [opened, setOpened] = useState(false);

  // Asked only once the menu is open, and only for a signed-in viewer: the panel
  // cannot accept a submission without a session, so an anonymous viewer's answer
  // could not change what this renders.
  const { data: bugReportArea } = trpc.feedback.getArea.useQuery(
    { area: SITE_BUG_REPORT_AREA },
    { enabled: opened && !!currentUser }
  );
  const canReportInProduct = !!currentUser && !!bugReportArea?.enabled;
  // The chat used to be the right-hand column of the support modal. It has its own
  // launcher beside this button, but the modal is gone, so the menu keeps a way in.
  const assistant = useAssistantAvailable();

  return (
    <Menu
      opened={opened}
      onChange={setOpened}
      position="top-end"
      width={230}
      shadow="md"
      // The footer is a sticky, overflow-scrolling bar; the app theme turns
      // `withinPortal` OFF for Popover by default, which Menu builds on, so this is
      // the difference between a dropdown and a clipped one.
      withinPortal
    >
      <Menu.Target>
        <Button pl={4} pr="xs" color="yellow" variant="light" size="xs">
          🛟 Support
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {canReportInProduct ? (
          <Menu.Item
            leftSection={<IconBug size={ICON_SIZE} />}
            onClick={() => dialogStore.trigger({ component: FeedbackDrawer })}
          >
            Report a bug
          </Menu.Item>
        ) : (
          // No session, or the area is not collecting: the ticket portal is the only
          // honest destination left. Shown rather than hidden so the menu never
          // silently loses its bug path.
          <Menu.Item
            component="a"
            href={SUPPORT_LINKS.bugTicket}
            target="_blank"
            rel="nofollow noreferrer"
            leftSection={<IconBug size={ICON_SIZE} />}
          >
            Report a bug
          </Menu.Item>
        )}
        <Menu.Item
          component="a"
          href={SUPPORT_LINKS.educationHub}
          target="_blank"
          rel="nofollow noreferrer"
          leftSection={<IconBook size={ICON_SIZE} />}
        >
          Education Hub
        </Menu.Item>
        <Menu.Item
          component="a"
          href={SUPPORT_LINKS.faq}
          target="_blank"
          rel="nofollow noreferrer"
          leftSection={<IconQuestionMark size={ICON_SIZE} />}
        >
          FAQ
        </Menu.Item>
        <Menu.Item
          component="a"
          href={SUPPORT_LINKS.discord}
          target="_blank"
          rel="nofollow noreferrer"
          leftSection={<IconBrandDiscord size={ICON_SIZE} />}
        >
          Discord Community
        </Menu.Item>
        {assistant && (
          <Menu.Item
            leftSection={<IconMessageChatbot size={ICON_SIZE} />}
            onClick={() => useAssistantPanelStore.setState({ opened: true })}
          >
            Get help fast
          </Menu.Item>
        )}
        <Menu.Divider />
        <Menu.Item
          component="a"
          href={SUPPORT_LINKS.portal}
          target="_blank"
          rel="nofollow noreferrer"
          leftSection={<IconLifebuoy size={ICON_SIZE} />}
        >
          Support Portal
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
