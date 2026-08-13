import { Badge, Group, Popover, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconShieldCheck } from '@tabler/icons-react';
import { useState } from 'react';

/**
 * Says the generator itself recorded the host image as an input to the
 * generation that produced this one.
 *
 * It only ever appears on the positive case, and there is deliberately no
 * counterpart for its absence — a remix made off-site can never earn it, so a
 * "not verified" marker would turn a missing signal into an accusation. The
 * popover says as much, because a badge nobody can explain invites the reader
 * to invent the negative for themselves.
 */
export function VerifiedRemixBadge({
  variant = 'full',
  className,
}: {
  /** `icon` for dense surfaces (a gallery tile); `full` where there's room for the label. */
  variant?: 'full' | 'icon';
  className?: string;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={280}
      position="top"
      withArrow
      shadow="md"
      radius="md"
    >
      <Popover.Target>
        {/* Click, not hover: the icon-only variant sits on gallery tiles that are
            themselves links, and a hover explainer there fires on the way past. */}
        <UnstyledButton
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOpened((o) => !o);
          }}
          aria-label="Verified remix — what this means"
          className={className}
        >
          {variant === 'icon' ? (
            <ThemeIcon size="sm" radius="xl" variant="filled" color="green">
              <IconShieldCheck size={12} />
            </ThemeIcon>
          ) : (
            <Badge
              size="sm"
              variant="light"
              color="green"
              leftSection={<IconShieldCheck size={12} />}
              className="cursor-pointer"
            >
              Verified remix
            </Badge>
          )}
        </UnstyledButton>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <Group
          gap={8}
          px="sm"
          py={8}
          wrap="nowrap"
          className="border-b border-gray-3 dark:border-dark-4"
        >
          <ThemeIcon size="sm" radius="xl" variant="light" color="green">
            <IconShieldCheck size={14} />
          </ThemeIcon>
          <Text size="sm" fw={600}>
            Verified remix
          </Text>
        </Group>

        <Stack gap={6} p="sm">
          <Text size="xs" c="dimmed">
            Our generator recorded the original image as an input to the generation that made this
            one, so the link is confirmed rather than claimed.
          </Text>
          <Text size="xs" c="dimmed">
            Remixes made off-site can&apos;t carry this, so plenty of real remixes won&apos;t have
            it. Its absence doesn&apos;t mean anything.
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
