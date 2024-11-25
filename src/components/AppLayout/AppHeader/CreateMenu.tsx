import { Button, Menu } from '@mantine/core';
import { IconChevronDown, IconPlus } from '@tabler/icons-react';
import { useGetActionMenuItems } from '~/components/AppLayout/AppHeader/hooks';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';

export function CreateMenu() {
  const features = useFeatureFlags();
  const isMobile = useIsMobile({ breakpoint: 'md' });

  return isMobile ? (
    <GenerateButton
      variant="light"
      py={8}
      px={12}
      h="auto"
      radius="sm"
      mode="toggle"
      compact
      className="inline-block md:hidden"
      data-activity="create:navbar"
    />
  ) : (
    <Menu
      position="bottom"
      offset={5}
      withArrow
      trigger="hover"
      openDelay={400}
      zIndex={constants.imageGeneration.drawerZIndex + 2}
      withinPortal
    >
      <Menu.Target>
        {features.imageGeneration ? (
          <div className="hide-mobile flex items-center">
            <GenerateButton
              variant="light"
              py={8}
              pl={12}
              pr={4}
              h="auto"
              radius="sm"
              mode="toggle"
              // Quick hack to avoid svg from going over the button. cc: Justin 👀
              sx={() => ({ borderTopRightRadius: 0, borderBottomRightRadius: 0 })}
              compact
              data-activity="create:navbar"
            />
            <Button
              variant="light"
              py={8}
              px={4}
              h="auto"
              radius="sm"
              sx={() => ({ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 })}
            >
              <IconChevronDown stroke={2} size={20} />
            </Button>
          </div>
        ) : (
          <Button
            className="hide-mobile flex @max-md:hidden"
            variant="filled"
            color="green"
            size="xs"
            pl={5}
          >
            <IconPlus size={16} /> New
          </Button>
        )}
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