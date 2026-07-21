import {
  Alert,
  Button,
  Card,
  Divider,
  Group,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconCircleCheck,
  IconInfoCircle,
  IconLock,
  IconRefresh,
  IconUserPlus,
  IconUsers,
} from '@tabler/icons-react';
import { useCreatorProgramRequirements } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';

/**
 * Creator Controls: USER-default metric privacy (level 1 of 3). Sets the baseline
 * hide flags for all of the creator's models. The flags only take effect while the
 * user holds a valid Creator Program membership (enforced read-side); non/lapsed
 * members see an upsell and disabled toggles.
 */
export function CreatorControlsCard() {
  const user = useCurrentUser();
  const flags = useFeatureFlags();
  const serverDomains = useServerDomains();
  const { requirements } = useCreatorProgramRequirements();
  const { hideModelBuzz, hideModelDownloads, hideModelGenerations, hideDonationGoals } =
    useCurrentUserSettings();
  const { mutate: mutateSetting, isPending: isLoadingSetting } = useMutateUserSettings();

  if (!user) return null;

  const isActiveMember = !!requirements?.validMembership;
  const membershipLapsed = !!requirements?.membershipLapsed;
  const renewUrl = syncAccount(`//${serverDomains.green}/pricing`);

  return (
    <Card withBorder id="creator-controls">
      <Stack>
        <Title order={2}>Creator Controls</Title>

        {isActiveMember ? (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
            <Text size="sm">
              These controls are a Creator Program benefit. They apply while your membership is
              active and revert if it lapses.
            </Text>
          </Alert>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-gray-2 bg-gray-0 p-6 text-center dark:border-dark-4 dark:bg-dark-5">
            <ThemeIcon size={48} variant="light" color="gray" radius="xl">
              {membershipLapsed ? <IconLock size={24} /> : <IconUsers size={24} />}
            </ThemeIcon>
            <Text fw={700} size="lg">
              {membershipLapsed ? 'Membership lapsed' : 'Creator Program members only'}
            </Text>
            <Text size="sm" c="dimmed" maw={380}>
              {membershipLapsed
                ? 'Renew your Creator Program membership to restore your Creator Controls and the rest of your perks:'
                : 'Gain more control over how your models are presented, plus the rest of the Creator Program:'}
            </Text>
            <Stack gap={6} align="flex-start" ta="left">
              {[
                'Hide your model metrics and donation goals',
                'Earn real cash from your creations',
                'Open your own creator shop',
              ].map((perk) => (
                <Group key={perk} gap={8} wrap="nowrap">
                  <IconCircleCheck
                    size={16}
                    className="shrink-0"
                    style={{ color: 'var(--mantine-color-green-6)' }}
                  />
                  <Text size="sm">{perk}</Text>
                </Group>
              ))}
            </Stack>
            <Button
              component="a"
              href={membershipLapsed ? renewUrl : '/creator-program'}
              variant="filled"
              size="sm"
              leftSection={membershipLapsed ? <IconRefresh size={16} /> : <IconUserPlus size={16} />}
              className="w-fit"
            >
              {membershipLapsed ? 'Renew membership' : 'Join the Creator Program'}
            </Button>
          </div>
        )}

        <Divider
          label={
            <Group gap={4} wrap="nowrap">
              Default metric privacy
              <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
                <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
                  You and moderators still see your real stats on model pages and cards. On search
                  results you see the hidden state, same as the public.
                </Text>
              </InfoPopover>
            </Group>
          }
        />
        <Switch
          name="hideModelBuzz"
          label="Hide tipped / earned Buzz"
          description="Others won't see the Buzz earned on your models."
          checked={hideModelBuzz ?? false}
          onChange={(e) => mutateSetting({ hideModelBuzz: e.target.checked })}
          disabled={isLoadingSetting || !isActiveMember}
          styles={{ track: { flex: '0 0 1em' } }}
        />
        <Switch
          name="hideModelDownloads"
          label="Hide download count"
          description="Others won't see how many times your models were downloaded."
          checked={hideModelDownloads ?? false}
          onChange={(e) => mutateSetting({ hideModelDownloads: e.target.checked })}
          disabled={isLoadingSetting || !isActiveMember}
          styles={{ track: { flex: '0 0 1em' } }}
        />
        <Switch
          name="hideModelGenerations"
          label="Hide generation count"
          description="Others won't see how many images were generated with your models."
          checked={hideModelGenerations ?? false}
          onChange={(e) => mutateSetting({ hideModelGenerations: e.target.checked })}
          disabled={isLoadingSetting || !isActiveMember}
          styles={{ track: { flex: '0 0 1em' } }}
        />

        {flags.donationGoals && (
          <>
            <Divider label="Donation goals" />
            <Switch
              name="hideDonationGoals"
              label="Hide my donation goals from public view"
              description="Others won't see the progress bar or collected amount. The goal still works."
              checked={hideDonationGoals ?? false}
              onChange={(e) => mutateSetting({ hideDonationGoals: e.target.checked })}
              disabled={isLoadingSetting || !isActiveMember}
              styles={{ track: { flex: '0 0 1em' } }}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}
