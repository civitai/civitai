import {
  Button,
  Center,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Progress,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useState } from 'react';
import { useQueryVault } from '~/components/Vault/vault.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useQueryVaultItems } from '../../components/Vault/vault.util';
import { GetPaginatedVaultItemsSchema } from '~/server/schema/vault.schema';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'civitai-vault' }),
          permanent: false,
        },
      };

    if (!session.user?.subscriptionId) {
      return {
        redirect: {
          destination: '/pricing',
          permanent: false,
        },
      };
    }
  },
});

export default function CivitaiVault() {
  const currentUser = useCurrentUser();
  const { vault, isLoading: isLoadingVault } = useQueryVault();
  const [filters, setFilters] = useState<Omit<GetPaginatedVaultItemsSchema, 'limit'>>({
    page: 1,
  });
  const {
    items,
    isLoading: isLoadingVaultItems,
    isRefetching,
    pagination,
  } = useQueryVaultItems(filters);
  const progress = vault ? (vault.usedStorageKb / vault.storageKb) * 100 : 0;

  return (
    <Container size="xl">
      <Group position="apart" align="flex-end" mb="xl">
        <Title order={1}>Civitai Vaut</Title>
        {vault && (
          <Stack spacing={0}>
            <Progress
              style={{ width: '100%' }}
              size="xl"
              value={progress}
              color={progress >= 100 ? 'red' : 'blue'}
              striped
              animate
            />
            <Text>
              {formatKBytes(vault.usedStorageKb)} of {formatKBytes(vault.storageKb)} Used
            </Text>
          </Stack>
        )}
      </Group>

      {isLoadingVault || isLoadingVaultItems ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <Table>
            <thead>
              <tr>
                <th>Models</th>
                <th>Creator</th>
                <th>Type</th>
                <th>Category</th>
                <th>Date Created</th>
                <th>Date Added</th>
                <th>Last Refreshed</th>
                <th>Notes</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <th colSpan={9}>
                    <Stack align="center" my="xl">
                      <ThemeIcon size={62} radius={100}>
                        <IconCloudOff />
                      </ThemeIcon>
                      <Text align="center">No items found.</Text>
                    </Stack>
                  </th>
                </tr>
              )}
            </tbody>
            {pagination && pagination.totalPages > 1 && (
              <Group position="apart">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  page={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
          </Table>
        </div>
      )}
    </Container>
  );
}
