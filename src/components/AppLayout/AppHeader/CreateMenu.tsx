import { Button, Menu, Popover, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBrush, IconChevronDown } from '@tabler/icons-react';
import type { MouseEventHandler } from 'react';
import { forwardRef } from 'react';
import { useGetActionMenuItems } from '~/components/AppLayout/AppHeader/hooks';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { useGenerationPanelStore } from '~/store/generation-panel.store';

const CreateMenuButtons = forwardRef<
  HTMLDivElement,
  {
    disabled?: boolean;
    onMouseEnter?: MouseEventHandler;
    onMouseLeave?: MouseEventHandler;
    onClick?: MouseEventHandler;
  }
>(({ disabled, onMouseEnter, onMouseLeave, onClick }, ref) => {
  const handleClick = () => {
    useGenerationPanelStore.setState((state) => ({ opened: !state.opened }));
  };

  return (
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      className="flex"
    >
      <Button
        variant="light"
        py={8}
        h="auto"
        radius="sm"
        size="compact-sm"
        className={'h-auto !px-2 py-2 @md:rounded-r-none @md:pr-1'}
        classNames={{ label: 'flex gap-2 items-center' }}
        data-activity="create:navbar"
        onClick={handleClick}
        disabled={disabled}
      >
        <IconBrush size={20} />
        <Text inherit inline className="hide-mobile">
          Create
        </Text>
      </Button>
      <Button
        variant="light"
        py={8}
        px={4}
        h="auto"
        radius="sm"
        className={'rounded-l-none @max-md:hidden'}
        disabled={disabled}
      >
        <IconChevronDown stroke={2} size={20} />
      </Button>
    </div>
  );
});
CreateMenuButtons.displayName = 'CreateMenuButtons';

export function CreateMenu() {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile({ breakpoint: 'md', type: 'media' });
  const isMuted = currentUser?.muted ?? false;
  const [opened, { open, close }] = useDisclosure(false);

  if (isMuted) {
    return (
      <Popover position="bottom" withArrow withinPortal opened={opened}>
        <Popover.Target>
          <CreateMenuButtons disabled onMouseEnter={open} onMouseLeave={close} onClick={open} />
        </Popover.Target>
        <Popover.Dropdown maw={300}>
          <Text size="sm">
            Your account has been restricted due to potential Terms of Service violations, and has
            been flagged for review. A Community Manager will investigate, and you will receive a
            determination notification within two business days. You do not need to contact us.
          </Text>
        </Popover.Dropdown>
      </Popover>
    );
  }

  return (
    <Menu
      position="bottom"
      offset={5}
      trigger="hover"
      openDelay={400}
      zIndex={imageGenerationDrawerZIndex + 2}
      disabled={isMobile}
      withinPortal
      withArrow
    >
      <Menu.Target>
        <CreateMenuButtons />
      </Menu.Target>
      <Menu.Dropdown>
        <CreateMenuContent />
      </Menu.Dropdown>
    </Menu>
  );
}

function CreateMenuContent() {
  const items = useGetActionMenuItems();
  return (
    <>
      {items
        .filter(({ visible }) => visible !== false)
        .map((link, index) => {
          const menuItem = (
            <Menu.Item
              key={!link.redirectReason ? index : undefined}
              component={NextLink}
              href={link.href}
              as={link.as}
              rel={link.rel}
            >
              <div className="flex items-center gap-2.5">
                <link.icon stroke={1.5} color={link.color} />
                {link.label}
                {link.currency && <CurrencyIcon currency={Currency.BUZZ} size={16} />}
              </div>
            </Menu.Item>
          );

          return link.redirectReason ? (
            <LoginRedirect key={index} reason={link.redirectReason} returnUrl={link.href}>
              {menuItem}
            </LoginRedirect>
          ) : (
            menuItem
          );
        })}
    </>
  );
}
