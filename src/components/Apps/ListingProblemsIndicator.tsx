import { HoverCard, List, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/** One advisory problem on a submission row (from the server's `computeListingProblems`). */
export type ListingProblem = { code: string; label: string };

/**
 * Advisory "listing incomplete" warning shown next to a submission's status. When
 * the row has one or more problems (missing assets / empty key fields) it renders
 * an orange warning triangle; hovering (or focusing) opens a card that enumerates
 * each problem's label. Renders NOTHING when `problems` is empty — a clean row shows
 * no icon. Heads-up only; it is NOT a hard gate.
 */
export function ListingProblemsIndicator({ problems }: { problems: ListingProblem[] }) {
  if (!problems || problems.length === 0) return null;
  return (
    <HoverCard width={260} position="top" withArrow shadow="md" withinPortal openDelay={100}>
      <HoverCard.Target>
        <ThemeIcon
          color="yellow"
          variant="light"
          size="sm"
          radius="xl"
          data-testid="apps-submission-problems"
          style={{ cursor: 'help' }}
          aria-label="This listing has problems"
          tabIndex={0}
        >
          <IconAlertTriangle size={14} />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="xs" fw={600} mb={4}>
          Listing needs attention
        </Text>
        <List size="xs" spacing={2}>
          {problems.map((p) => (
            <List.Item key={p.code}>{p.label}</List.Item>
          ))}
        </List>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
