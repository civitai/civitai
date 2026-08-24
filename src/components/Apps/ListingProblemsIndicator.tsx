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
          {/*
            🔴 THE KEY IS code+label, NOT code, BECAUSE A CODE IS NOT UNIQUE PER ROW.
            `computeListingProblems` emits ONE `blocked-media` (and one `scanning-media`)
            PER ASSET SLOT, so a listing whose icon AND cover both came back `Blocked`
            yields two items sharing the code `blocked-media` and differing only in their
            label ("Replace the blocked icon…" / "…cover…"). Keying on the code alone made
            those React-duplicate.

            This was latent rather than wrong: the scan codes could not reach any list row
            until `listMyAppListings` started passing `assetScans`, so the only surface
            that renders this component never produced two items with one code. The wiring
            change is what makes the case reachable, so the key is fixed with it.
          */}
          {problems.map((p) => (
            <List.Item key={`${p.code}:${p.label}`}>{p.label}</List.Item>
          ))}
        </List>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
