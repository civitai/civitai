import { HoverCard, List, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/** One problem on a submission row (from the server's `computeListingProblems`).
 *  `severity` is optional for backward-compat: absent ⇒ treated as advisory. */
export type ListingProblem = { code: string; label: string; severity?: 'blocking' | 'advisory' };

/**
 * Warning shown next to a listing's status. When the row has one or more problems it
 * renders a warning triangle; hovering (or focusing) opens a card that enumerates each
 * problem's label. The icon is RED when a `blocking` problem is present and YELLOW when
 * only advisory ones remain. Renders NOTHING when `problems` is empty.
 *
 * `blocking` problems are enforced at review: approving a listing into the store without an
 * icon and a cover is refused (the publish floor, `checkListingMeetsFloor`, on an on-site
 * first version's draft and the off-site approve paths — not on a moderator reset's
 * re-approve, a moderator relist or an owner's immediate republish, which restore a listing
 * that already went live), and a blocked image keeps it
 * from going live (the scan-clean gate).
 * This component only REPORTS them; the gates are server-side. So the card groups by
 * severity: "Required before publishing" lists ONLY the blocking problems, and everything
 * advisory (screenshots, description, tagline, category, a still-scanning image) sits under
 * "Recommended" — never under the required heading.
 */
export function ListingProblemsIndicator({ problems }: { problems: ListingProblem[] }) {
  if (!problems || problems.length === 0) return null;
  const blocking = problems.filter((p) => p.severity === 'blocking');
  const advisory = problems.filter((p) => p.severity !== 'blocking');
  const hasBlocking = blocking.length > 0;
  // A hidden listing is a fact about the live store, not a recommendation.
  const hasHidden = problems.some((p) => p.code === 'hidden-mature-rating');
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
        {hasBlocking && (
          <ProblemGroup
            heading="Required before publishing"
            problems={blocking}
            testId="apps-submission-problems-required"
          />
        )}
        {advisory.length > 0 && (
          <ProblemGroup
            heading={hasHidden ? 'Heads up' : 'Recommended'}
            problems={advisory}
            testId="apps-submission-problems-advisory"
            spaced={hasBlocking}
          />
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function ProblemGroup({
  heading,
  problems,
  testId,
  spaced = false,
}: {
  heading: string;
  problems: ListingProblem[];
  testId: string;
  spaced?: boolean;
}) {
  return (
    <div data-testid={testId} style={spaced ? { marginTop: 8 } : undefined}>
      <Text size="xs" fw={600} mb={4}>
        {heading}
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
    </div>
  );
}
