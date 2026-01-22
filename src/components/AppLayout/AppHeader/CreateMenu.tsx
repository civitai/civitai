import { Button, Menu, Popover, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBrush, IconChevronDown } from '@tabler/icons-react';
import { useGetActionMenuItems } from '~/components/AppLayout/AppHeader/hooks';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { GenerateButtonBasic } from '~/components/RunStrategy/GenerateButtonBasic';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import clsx from 'clsx';

function CreateMenuButtons({ disabled = false }: { disabled?: boolean }) {
  return (
    <>
      <Button
        variant="light"
        py={8}
        h="auto"
        radius="sm"
        size="compact-sm"
        className={clsx('h-auto !px-2 py-2 @md:rounded-r-none @md:pr-1', {
          ['pointer-events-none  opacity-50']: disabled,
        })}
        classNames={{ label: 'flex gap-2 items-center' }}
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
        className={clsx('rounded-l-none @max-md:hidden', {
          ['pointer-events-none  opacity-50']: disabled,
        })}
      >
        <IconChevronDown stroke={2} size={20} />
      </Button>
    </>
  );
}

export function CreateMenu() {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile({ breakpoint: 'md', type: 'media' });
  const isMuted = currentUser?.muted ?? false;
  const [opened, { open, close }] = useDisclosure(false);

  if (isMuted) {
    return (
      <Popover position="bottom" withArrow withinPortal opened={opened}>
        <Popover.Target>
          <span
            className="inline-flex cursor-not-allowed items-center"
            onMouseEnter={open}
            onMouseLeave={close}
            onClick={open}
          >
            <CreateMenuButtons disabled />
          </span>
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
        <div className="flex items-center">
          <CreateMenuButtons />
        </div>
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
