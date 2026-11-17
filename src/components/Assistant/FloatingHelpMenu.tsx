import { Button } from '@mantine/core';
import { IconBug, IconCat, IconHelp, IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { AssistantChat } from '~/components/Assistant/AssistantChat';
import { useAssistantAvailable } from '~/components/Assistant/useAssistantAvailable';
import { IsClient } from '~/components/IsClient/IsClient';
import { Menu } from '~/components/MantineOverlays';
import { useAssistantItem, useReportBugItem } from '~/components/Support/useSupportMenuItems';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';

const WIDTH = 320;
const HEIGHT = 500;

/**
 * The floating button in the footer's corner cluster. It opens a menu with CivBot (when the
 * assistant is available) and "Report a problem"; while the CivBot chat is open it becomes the
 * chat's close button.
 *
 * "Report a problem" is `useReportBugItem`, the same entry as the Support menus: the in-product
 * report when the bug-report area is collecting for this user, the ticket portal otherwise.
 */
export function FloatingHelpMenu() {
  const currentUser = useCurrentUser();
  const chatOpen = useAssistantPanelStore((state) => state.opened);
  const assistant = useAssistantAvailable();
  const [menuOpened, setMenuOpened] = useState(false);
  const reportBug = useReportBugItem({ opened: menuOpened });
  const assistantItem = useAssistantItem();

  if (!currentUser) return null;

  const civchan = assistant?.personality === 'civchan';
  const TriggerIcon = !assistant ? IconHelp : civchan ? IconCat : IconMessageChatbot;
  const AssistantIcon = civchan ? IconCat : IconMessageChatbot;

  return (
    <IsClient>
      {chatOpen && assistant && (
        <div className="absolute bottom-full right-0 mb-1">
          <AssistantChat width={WIDTH} height={HEIGHT} />
        </div>
      )}
      {chatOpen && assistant ? (
        <Button
          px="xs"
          color="gray"
          aria-label={`Close ${civchan ? 'Civchan' : 'CivBot'}`}
          onClick={() => useAssistantPanelStore.setState({ opened: false })}
        >
          <IconX size={20} stroke={2.5} />
        </Button>
      ) : (
        <Menu opened={menuOpened} onChange={setMenuOpened} position="top-end" shadow="md">
          <Menu.Target>
            <Button px="xs" color={civchan ? 'pink' : 'blue'} aria-label="Help and feedback">
              <TriggerIcon size={20} stroke={2.5} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {assistantItem && (
              <Menu.Item leftSection={<AssistantIcon size={16} />} onClick={assistantItem.onClick}>
                Ask {civchan ? 'Civchan' : 'CivBot'}
              </Menu.Item>
            )}
            {reportBug.href ? (
              <Menu.Item
                component="a"
                href={reportBug.href}
                target="_blank"
                rel="nofollow noreferrer"
                leftSection={<IconBug size={16} />}
              >
                Report a problem
              </Menu.Item>
            ) : (
              <Menu.Item leftSection={<IconBug size={16} />} onClick={reportBug.onClick}>
                Report a problem
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      )}
    </IsClient>
  );
}
