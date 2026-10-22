import { Button, Menu } from '@mantine/core';
import React, { useState } from 'react';
import { useSupportMenuItems } from '~/components/Support/useSupportMenuItems';

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
  const [opened, setOpened] = useState(false);
  const items = useSupportMenuItems({ opened });

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
        {items.map((item) => (
          <React.Fragment key={item.id}>
            {item.id === 'support-portal' && <Menu.Divider />}
            {item.href ? (
              <Menu.Item
                component="a"
                href={item.href}
                target="_blank"
                rel="nofollow noreferrer"
                leftSection={<item.icon size={ICON_SIZE} />}
              >
                {item.label}
              </Menu.Item>
            ) : (
              <Menu.Item leftSection={<item.icon size={ICON_SIZE} />} onClick={item.onClick}>
                {item.label}
              </Menu.Item>
            )}
          </React.Fragment>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
