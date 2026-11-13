import { Badge, Container, Group, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { INVENTORY_PAGES } from '~/components/Inventory/inventory-pages';
import type { InventoryType } from '~/components/Inventory/inventory-types';
import { enabledInventoryTypes } from '~/components/Inventory/inventory-types';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';

export const inventoryUrl = (key: string) => `/user/inventory/${key}`;

export function InventoryLayout({ typeKey }: { typeKey: string }) {
  const features = useOptionalFeatureFlags();
  const types = enabledInventoryTypes(features);
  const current = types.find((type) => type.key === typeKey);
  const Page = current && INVENTORY_PAGES[current.key];

  return (
    <Container size="lg" py="lg">
      <Meta title="Inventory | Civitai" deIndex />
      <Title order={1} mb="md">
        Inventory
      </Title>
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <nav
          aria-label="Inventory"
          className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 md:mx-0 md:w-56 md:flex-col md:px-0"
        >
          {types.map((type) => (
            <InventoryNavLink key={type.key} type={type} active={type.key === typeKey} />
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {Page ? (
            <Page />
          ) : (
            <Stack align="center" py="xl">
              <Text c="dimmed">Nothing to show here.</Text>
            </Stack>
          )}
        </div>
      </div>
    </Container>
  );
}

function InventoryNavLink({ type, active }: { type: InventoryType; active: boolean }) {
  const count = type.useCount();
  const Icon = type.icon;
  return (
    <NextLink
      href={inventoryUrl(type.key)}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex shrink-0 items-center rounded-md px-3 py-2 text-sm no-underline',
        active
          ? 'bg-gray-1 font-semibold text-black dark:bg-dark-5 dark:text-white'
          : 'text-gray-7 hover:bg-gray-0 dark:text-dark-0 dark:hover:bg-dark-6'
      )}
    >
      <Group gap="xs" wrap="nowrap" className="w-full">
        <Icon size={18} />
        <span className="flex-1 whitespace-nowrap">{type.label}</span>
        {!!count && (
          <Badge size="sm" variant="filled" radius="xl">
            {count}
          </Badge>
        )}
      </Group>
    </NextLink>
  );
}
