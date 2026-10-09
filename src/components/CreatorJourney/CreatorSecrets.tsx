import { Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { earnedLabel, Hexagon } from '~/components/CreatorJourney/CreatorAchievements';
import { accentVar, TierBadge } from '~/components/CreatorJourney/tier-badge';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HIDDEN_ACHIEVEMENT_PLACEHOLDER } from '~/shared/constants/creator-journey.constants';
import type { RouterOutput } from '~/types/router';

type Secret = RouterOutput['creatorJourney']['getMine']['secrets'][number];

export const SECRET_ACCENT = '#7950f2';

export function CreatorSecrets({ secrets }: { secrets: Secret[] }) {
  if (secrets.length === 0) return null;
  const found = secrets.filter((secret) => secret.earned).length;

  return (
    <Stack gap="sm" style={accentVar(SECRET_ACCENT)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Title order={2} size="h3">
          Hidden Achievements
        </Title>
        <Text size="sm" c="dimmed" className="tabular-nums">
          {found} of {secrets.length} found
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {secrets.map((secret) => (
          <SecretTile key={secret.key} secret={secret} />
        ))}
      </div>
    </Stack>
  );
}

function SecretTile({ secret }: { secret: Secret }) {
  return (
    <div
      data-state={secret.earned ? 'earned' : 'locked'}
      className={clsx(
        'flex min-w-0 items-center gap-3 rounded-md border border-solid bg-white p-3 dark:bg-dark-6',
        secret.earned
          ? 'border-[color-mix(in_srgb,var(--cj-accent)_45%,transparent)]'
          : 'border-dashed border-gray-4 dark:border-dark-3'
      )}
    >
      {secret.badgeUrl ? (
        <TierBadge name={secret.name} badgeUrl={secret.badgeUrl} state="earned" size={52} />
      ) : secret.earned ? (
        <Hexagon label="?" state="earned" size={52} />
      ) : (
        <EdgeMedia
          src={HIDDEN_ACHIEVEMENT_PLACEHOLDER}
          alt=""
          width={144}
          // The placeholder art is drawn about a tenth narrower than a regular hexagon.
          className="size-[52px] shrink-0 scale-x-110 object-contain"
          optimized
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Text size="sm" fw={700} truncate>
          {secret.name}
        </Text>
        {secret.earned ? (
          <>
            {secret.description && (
              <Text size="xs" c="dimmed">
                {secret.description}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {earnedLabel(secret.achievedAt)}
            </Text>
          </>
        ) : (
          secret.hint && (
            <Text size="xs" c="dimmed" fs="italic">
              {secret.hint}
            </Text>
          )
        )}
      </div>
    </div>
  );
}
