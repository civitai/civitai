import {
  Center,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Table,
  Text,
  ThemeIcon,
  Stack,
  Title,
  Button,
  ActionIcon,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconEdit } from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';

export default function Rewards() {
  return (
    <>
      <Meta title="Cosmetic Shop - Settings" deIndex />
      <Container size="xs">
        <Stack spacing={0} mb="xl">
          <Title order={1}>Cosmetic Shop</Title>
          <Text size="sm" color="dimmed">
            Manage products and sections for the Cosmetic Shop.
          </Text>
        </Stack>
        <Group mb="md" grow>
          <Button component={NextLink} href="/moderator/cosmetic-store/products">
            <IconEdit />
            Manage Products
          </Button>
          <Button component={NextLink} href="/moderator/cosmetic-store/sections">
            <IconEdit />
            Manage Sections
          </Button>
        </Group>
      </Container>
    </>
  );
}
