import { Button, Card, Divider, Stack, Switch, Text, Title } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useCreatorProgramRequirements } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
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
        <div>
          <Title order={2}>Creator Controls</Title>
          <Text size="sm" c="dimmed">
            Hide public metrics and donation goals on your models. These are Creator Program
            benefits — they only apply while your membership is active, and revert to visible if it
            lapses. You and moderators always see your real stats on model pages and cards; on
            search results you&apos;ll see the hidden state, same as the public.
          </Text>
        </div>

        {!isActiveMember && (
          <Card withBorder radius="md" className="bg-gray-0 dark:bg-dark-6">
            <Stack gap="xs">
              <Text fw={600}>
                {membershipLapsed
                  ? 'Your Creator Program membership has lapsed'
                  : 'A Creator Program membership is required'}
              </Text>
              <Text size="sm" c="dimmed">
                {membershipLapsed
                  ? 'Renew to keep your metric-privacy settings active. While lapsed, your metrics are shown publicly again.'
                  : 'Join the Creator Program to hide your model metrics from the public.'}
              </Text>
              <Button
                component="a"
                href={membershipLapsed ? renewUrl : '/creator-program'}
                leftSection={<IconBolt size={16} />}
                variant="light"
                color="yellow"
                w="fit-content"
              >
                {membershipLapsed ? 'Renew membership' : 'Join the Creator Program'}
              </Button>
            </Stack>
          </Card>
        )}

        <Divider label="Default metric privacy" />
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
              description="Others won't see the progress bar or collected amount on your donation goals. The goal keeps working, and you and moderators can still see it."
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
