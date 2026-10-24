import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MysteryBoxArt } from '~/components/MysteryBox/MysteryBoxArt';
import { MysteryBoxOddsBar } from '~/components/MysteryBox/MysteryBoxOddsBar';
import type { MysteryBoxCatalogView } from '~/components/MysteryBox/mystery-box.utils';
import {
  MYSTERY_BOX_FALLBACK_DESCRIPTION,
  mysteryBoxOddsPageUrl,
  sharedBaseTierOdds,
} from '~/components/MysteryBox/mystery-box.utils';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { numberWithCommas } from '~/utils/number-helpers';

const COLOR = 'var(--mantine-color-violet-5)';

/**
 * A mystery box for a viewer not on a team: its base odds, a link to its contents and odds page, and
 * what it takes to open one (signing in, or joining a team).
 */
export function MysteryBoxCatalogCard({ box }: { box: MysteryBoxCatalogView }) {
  const currentUser = useCurrentUser();
  const odds = sharedBaseTierOdds(box);

  return (
    <div
      className="grid grid-cols-1 items-center gap-4 rounded-xl border border-solid p-4 sm:grid-cols-[120px_1fr_auto]"
      style={{
        borderColor: COLOR,
        background: `linear-gradient(120deg, color-mix(in srgb, ${COLOR} 18%, transparent), transparent 60%)`,
      }}
      data-testid="mystery-box-catalog-card"
    >
      <MysteryBoxArt color={COLOR} size={120} className="mx-auto" />
      <Stack gap={6}>
        <Group gap="xs">
          <Badge variant="filled" style={{ background: COLOR }}>
            Mystery Box
          </Badge>
          <Text size="sm" fw={700}>
            {numberWithCommas(box.unitAmount)} Buzz
          </Text>
        </Group>
        <Text fw={700} size="lg">
          {box.name}
        </Text>
        <Text size="sm" c="dimmed">
          {box.description ?? MYSTERY_BOX_FALLBACK_DESCRIPTION}
        </Text>
        {odds ? (
          <MysteryBoxOddsBar tiers={odds} />
        ) : (
          <Text size="xs" c="dimmed" data-testid="box-odds-by-team">
            The odds differ by team. Each team&apos;s are on the odds page.
          </Text>
        )}
      </Stack>
      <Stack gap="xs" align="stretch">
        <Button
          component={NextLink}
          href={mysteryBoxOddsPageUrl({ boxDefinitionId: box.boxDefinitionId, team: undefined })}
          variant="light"
          data-testid="box-catalog-odds-link"
        >
          See contents &amp; odds
        </Button>
        {currentUser ? (
          <Text size="sm" ta="center" maw={200} data-testid="box-catalog-join">
            Join a team to open boxes in your color.
          </Text>
        ) : (
          <LoginRedirect reason="perform-action">
            <Button data-testid="box-catalog-sign-in">Sign in to open</Button>
          </LoginRedirect>
        )}
      </Stack>
    </div>
  );
}
