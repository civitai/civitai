import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconGift } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { setCookie, deleteCookies } from '~/utils/cookies-helpers';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { constants } from '~/server/common/constants';
import dayjs from '~/shared/utils/dayjs';
import { trpc } from '~/utils/trpc';

function formatBuzz(n: number) {
  return n.toLocaleString();
}

export function ReferralCheckoutBanner({
  monthlyBuzzByTier,
}: {
  monthlyBuzzByTier?: Partial<Record<string, number>>;
}) {
  const { code } = useReferralsContext();
  const [entry, setEntry] = useState('');
  const [applied, setApplied] = useState<string | undefined>(code);

  useEffect(() => {
    setApplied(code);
  }, [code]);

  const trackMutation = trpc.referral.trackCheckoutView.useMutation();
  const trackRef = useRef(trackMutation);
  trackRef.current = trackMutation;

  useEffect(() => {
    if (applied) {
      trackRef.current.mutate({ code: applied });
    }
  }, [applied]);

  const handleApply = () => {
    const next = entry.trim().toUpperCase();
    if (!next) return;
    const expirationDate = dayjs().add(constants.referrals.cookieDurationDays, 'day').toDate();
    setCookie('ref_code', next, expirationDate);
    setApplied(next);
  };

  const handleClear = () => {
    deleteCookies(['ref_code']);
    setApplied(undefined);
    setEntry('');
  };

  if (applied) {
    const bonusLines = ['bronze', 'silver', 'gold']
      .map((tier) => {
        const monthlyBuzz = monthlyBuzzByTier?.[tier];
        if (!monthlyBuzz) return null;
        const bonus = Math.floor(monthlyBuzz * constants.referrals.refereeBonusBuzzPct);
        return `${tier.charAt(0).toUpperCase()}${tier.slice(1)}: ${formatBuzz(bonus)} Blue Buzz`;
      })
      .filter(Boolean) as string[];

    return (
      <Alert icon={<IconGift size={18} />} color="pink" radius="md">
        <Stack gap={4}>
          <Text fw={600}>
            Using referral code <span className="font-mono">{applied}</span>
          </Text>
          <Text size="sm">
            You&apos;ll receive a one-time Blue Buzz bonus on completion
            {bonusLines.length ? ` — ${bonusLines.join(', ')}.` : '.'}
          </Text>
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" c="dimmed">
              Bonus amount is 25% of the tier&apos;s monthly Buzz.{' '}
              <a
                href="/content/referrals/terms"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Program Terms
              </a>
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={handleClear}>
              Remove code
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }

  return (
    <Alert color="gray" radius="md">
      <Stack gap={6}>
        <Text size="sm" fw={600}>
          Got a referral code?
        </Text>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            placeholder="Enter referral code"
            value={entry}
            onChange={(e) => setEntry(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button onClick={handleApply} disabled={!entry.trim()} variant="light">
            Apply
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
