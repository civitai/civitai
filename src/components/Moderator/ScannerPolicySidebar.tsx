import { Alert, Badge, Box, Group, List, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';
import { getScannerLabelPolicy } from '~/components/Moderator/scannerLabelPolicies';

/**
 * Sidebar shown on the focused-review page. Displays the moderator-friendly
 * policy summary for the current label so the reviewer always has the rules
 * in view while verdicting.
 */
export function ScannerPolicySidebar({ label }: { label: string }) {
  const policy = getScannerLabelPolicy(label);

  if (!policy) {
    return (
      <Box style={{ width: 440 }}>
        <Stack gap="xs" p="md">
          <Title order={4} style={{ fontFamily: 'monospace' }}>
            {label}
          </Title>
          <Alert color="gray">No moderator policy summary on file for this label yet.</Alert>
        </Stack>
      </Box>
    );
  }

  return (
    <Box style={{ width: 440 }}>
      <Stack gap="md" p="md">
        <Stack gap={4}>
          <Text c="dimmed" size="xs" tt="uppercase" fw={500}>
            Policy
          </Text>
          <Title order={3} style={{ fontFamily: 'monospace' }}>
            {policy.title}
          </Title>
        </Stack>

        <Box>
          <Badge variant="light" color="blue" size="sm" mb={6}>
            Catch
          </Badge>
          <Text size="sm">{policy.catch}</Text>
        </Box>

        <PolicySection
          heading="Should fire on"
          color="green"
          icon={<IconCheck size={12} />}
          items={policy.shouldFire}
        />

        <PolicySection
          heading="Should NOT fire on"
          color="red"
          icon={<IconX size={12} />}
          items={policy.shouldNotFire}
        />

        {policy.gotchas && policy.gotchas.length > 0 && (
          <PolicySection
            heading="Gotchas"
            color="yellow"
            icon={<IconAlertTriangle size={12} />}
            items={policy.gotchas}
          />
        )}

        <Text size="xs" c="dimmed">
          Only the <strong>positive prompt</strong> decides the verdict — terms appearing only in
          the negative prompt are avoidance signals.
        </Text>
      </Stack>
    </Box>
  );
}

function PolicySection({
  heading,
  color,
  icon,
  items,
}: {
  heading: string;
  color: string;
  icon: React.ReactNode;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <Box>
      <Group gap={6} mb={6}>
        <ThemeIcon variant="light" color={color} size="sm" radius="xl">
          {icon}
        </ThemeIcon>
        <Text size="xs" tt="uppercase" fw={600} c={color}>
          {heading}
        </Text>
      </Group>
      <List size="sm" spacing={4} listStyleType="disc" withPadding>
        {items.map((item, i) => (
          <List.Item key={i}>
            <Text size="sm" component="span">
              {item}
            </Text>
          </List.Item>
        ))}
      </List>
    </Box>
  );
}
