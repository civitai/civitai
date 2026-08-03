import { HoverCard, List, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/** One advisory problem on a submission row (from the server's `computeListingProblems`).
 *  `severity` is optional for backward-compat: absent ⇒ treated as advisory. */
export type ListingProblem = { code: string; label: string; severity?: 'blocking' | 'advisory' };

/**
 * "Listing incomplete" warning shown next to a submission's status. When the row
 * has one or more problems (missing assets / empty key fields) it renders a warning
 * triangle; hovering (or focusing) opens a card that enumerates each problem's
 * label. The icon is RED when the listing is below the publish floor (a `blocking`
 * problem — missing icon/cover) and YELLOW when only advisory items remain
 * (screenshots / empty text). Renders NOTHING when `problems` is empty. Heads-up
 * only; it is NOT a hard gate.
 */
export function ListingProblemsIndicator({ problems }: { problems: ListingProblem[] }) {
  if (!problems || problems.length === 0) return null;
  const hasBlocking = problems.some((p) => p.severity === 'blocking');
  return (
    <HoverCard width={280} position="top" withArrow shadow="md" withinPortal openDelay={100}>
      <HoverCard.Target>
        <ThemeIcon
          color={hasBlocking ? 'red' : 'yellow'}
          variant="light"
          size="sm"
          radius="xl"
          data-testid="apps-submission-problems"
          style={{ cursor: 'help' }}
          aria-label={
            hasBlocking ? 'This listing cannot be published yet' : 'This listing has advisory notes'
          }
          tabIndex={0}
        >
          <IconAlertTriangle size={14} />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="xs" fw={600} mb={4}>
          {hasBlocking ? 'Required before publishing' : 'Recommended'}
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
