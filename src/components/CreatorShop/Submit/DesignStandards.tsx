import {
  Button,
  Group,
  Image,
  List,
  Paper,
  Popover,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconDownload, IconPointFilled } from '@tabler/icons-react';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { COSMETIC_STANDARDS } from '~/components/CreatorShop/Submit/standards.constants';
import { cosmeticTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';
import type { CosmeticType } from '~/shared/utils/prisma/enums';

// A single requirements row whose "<type> design standards" text is an
// abbr-style dashed-underline trigger that opens the per-type standards and the
// matching starter template in a popover, keeping the submit form compact.
export function DesignStandardsRow({ type }: { type: CosmeticType }) {
  const standard = COSMETIC_STANDARDS[type];
  if (!standard) return null;

  const { requirements, template } = standard;
  const typeLabel = cosmeticTypeOptions.find((o) => o.value === type)?.label ?? '';

  return (
    <Group
      gap={9}
      px="md"
      py={9}
      wrap="nowrap"
      align="center"
      style={{ borderTop: CREATOR_SHOP_BORDER }}
    >
      <IconPointFilled size={10} color="var(--mantine-color-dimmed)" />
      <Text size="sm" style={{ flex: 1 }}>
        Follows{' '}
        <Popover width={320} position="top" withArrow shadow="md">
          <Popover.Target>
            <UnstyledButton
              style={{
                display: 'inline',
                font: 'inherit',
                color: 'inherit',
                textDecoration: 'underline',
                textDecorationStyle: 'dashed',
                textUnderlineOffset: 3,
                cursor: 'pointer',
              }}
            >
              {typeLabel} design standards
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown p="sm">
            <Stack gap="sm">
              <Text size="sm" fw={600}>
                {typeLabel} design standards
              </Text>
              <List spacing={6} size="xs" center icon={<IconPointFilled size={8} />}>
                {requirements.map((r) => (
                  <List.Item key={r.key}>{r.label}</List.Item>
                ))}
              </List>
              <Paper withBorder radius="md" p={6} pl={8} bg="var(--mantine-color-default-hover)">
                <Group align="center" wrap="nowrap" gap="sm">
                  <Image
                    src={template.url}
                    alt="Template"
                    w={40}
                    h={40}
                    fit="contain"
                    radius="sm"
                  />
                  <Button
                    component="a"
                    href={template.url}
                    download={template.downloadName}
                    variant="light"
                    size="xs"
                    leftSection={<IconDownload size={14} />}
                    style={{ flex: 1 }}
                  >
                    Start from template
                  </Button>
                </Group>
              </Paper>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </Text>
    </Group>
  );
}
