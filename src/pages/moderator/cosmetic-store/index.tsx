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
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconEdit, IconRosette } from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';

export default function Rewards() {
  return (
    <>
      <Meta title="Cosmetic Shop - Settings" deIndex />
      <Container size="xs">
        <Stack gap={0} mb="xl">
          <Title order={1}>Cosmetic Shop</Title>
          <Text size="sm" c="dimmed">
            Manage products and sections for the Cosmetic Shop.
          </Text>
        </Stack>
        <Stack mb="md" gap="sm">
          <Group grow>
            <Button component={Link} href="/moderator/cosmetic-store/products">
              <IconEdit />
              Manage Products
            </Button>
            <Button component={Link} href="/moderator/cosmetic-store/sections">
              <IconEdit />
              Manage Sections
            </Button>
          </Group>
          <Button
            component={Link}
            href="/moderator/cosmetic-store/badges"
            variant="light"
            fullWidth
          >
            <IconRosette />
            Manage Product Badges
          </Button>
        </Stack>
      </Container>
    </>
  );
}
