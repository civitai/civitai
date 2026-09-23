import { Alert, Button, Card, Divider, Group, Stack, Switch, Text, Title } from '@mantine/core';
import {
  IconInfoCircle,
  IconLock,
  IconRefresh,
  IconUserPlus,
  IconUsers,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useCreatorProgramRequirements } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { PlacementSpaceSection } from '~/components/Account/PlacementSpaceSection';
import { RemixGallerySettings } from '~/components/RemixGallery/RemixGallerySettings';
import { SettingRow, SettingsSection, UpsellPanel } from '~/components/Account/SettingsLayout';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { useSyncAccount } from '~/hooks/useSyncAccount';

/**
 * Creator Controls: USER-default metric privacy (level 1 of 3). Sets the baseline
 * hide flags for all of the creator's models. The flags only take effect while the
 * user holds a valid Creator Program membership (enforced read-side); non/lapsed
 * members see an upsell and disabled toggles.
 *
 * Renting out space on your own images — stickers and remix galleries — is NOT a
 * membership benefit. In the legacy card that boundary is positional: the alert says
 * "below this point", so nothing ungated may be moved beneath it.
 */
export function CreatorControlsCard({
  flat,
  stickerFooter,
}: { flat?: boolean; stickerFooter?: ReactNode } = {}) {
  const user = useCurrentUser();
  const flags = useFeatureFlags();
  const serverDomains = useServerDomains();
  const syncAccount = useSyncAccount();
  const { requirements } = useCreatorProgramRequirements();
  const { hideModelBuzz, hideModelDownloads, hideModelGenerations, hideDonationGoals } =
    useCurrentUserSettings();
  const { mutate: mutateSetting, isPending: isLoadingSetting } = useMutateUserSettings();

  if (!user) return null;
  // With neither half, the card would be a bare heading.
  if (!flags.creatorControls && !flags.stickerPlacement && !flags.remixGallery)
    return <>{stickerFooter}</>;

  const isActiveMember = !!requirements?.validMembership;
  const membershipLapsed = !!requirements?.membershipLapsed;
  const renewUrl = syncAccount(`//${serverDomains.green}/pricing`);

  const metricSwitches = [
    {
      name: 'hideModelBuzz',
      label: 'Hide tipped / earned Buzz',
      description: "Others won't see Buzz earned on your models.",
      checked: hideModelBuzz ?? false,
      onChange: (checked: boolean) => mutateSetting({ hideModelBuzz: checked }),
    },
    {
      name: 'hideModelDownloads',
      label: 'Hide download count',
      description: "Others won't see your download counts.",
      checked: hideModelDownloads ?? false,
      onChange: (checked: boolean) => mutateSetting({ hideModelDownloads: checked }),
    },
    {
      name: 'hideModelGenerations',
      label: 'Hide generation count',
      description: "Others won't see your generation counts.",
      checked: hideModelGenerations ?? false,
      onChange: (checked: boolean) => mutateSetting({ hideModelGenerations: checked }),
    },
    ...(flags.donationGoals
      ? [
          {
            name: 'hideDonationGoals',
            label: 'Hide my donation goals from public view',
            description: "Others won't see the progress or amount. The goal still works.",
            checked: hideDonationGoals ?? false,
            onChange: (checked: boolean) => mutateSetting({ hideDonationGoals: checked }),
          },
        ]
      : []),
  ];

  const membershipUpsell = (
    <UpsellPanel
      icon={membershipLapsed ? <IconLock size={24} /> : <IconUsers size={24} />}
      title={membershipLapsed ? 'Membership lapsed' : 'Creator Program members only'}
      description={
        membershipLapsed
          ? 'Renew your Creator Program membership to restore the controls below and the rest of your perks:'
          : 'Gain more control over how your models are presented, plus the rest of the Creator Program:'
      }
      perks={['Hide your model metrics and donation goals', 'Earn real cash from your creations']}
      action={
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
      }
    />
  );

  if (flat)
    return (
      <div id="creator-controls" className="flex flex-col gap-8">
        {flags.creatorControls && (
          <SettingsSection
            title={
              <Group gap={4} wrap="nowrap">
                Metric visibility
                <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
                  <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
                    You and moderators still see your real stats on model pages and cards. On search
                    results you see the hidden state, same as the public.
                  </Text>
                </InfoPopover>
              </Group>
            }
            description="Creator Program members only. Reverts if your membership lapses."
          >
            {!isActiveMember && <SettingRow block>{membershipUpsell}</SettingRow>}
            {metricSwitches.map((setting) => (
              <SettingRow
                key={setting.name}
                label={setting.label}
                description={setting.description}
                control={
                  <Switch
                    name={setting.name}
                    aria-label={setting.label}
                    checked={setting.checked}
                    onChange={(e) => setting.onChange(e.target.checked)}
                    disabled={isLoadingSetting || !isActiveMember}
                  />
                }
              />
            ))}
          </SettingsSection>
        )}
        <PlacementSpaceSection flat footer={stickerFooter} />
        <RemixGallerySettings flat />
      </div>
    );

  return (
    <Card withBorder id="creator-controls">
      <Stack>
        <Title order={2}>Creator Controls</Title>

        <PlacementSpaceSection />

        <RemixGallerySettings />

        {/* The Creator Program half. Gated apart from the sticker section
            above, which anyone may use on their own images. */}
        {flags.creatorControls && (
          <>
            {/* Opens the gated region, so the alert underneath reads as belonging
                to what follows rather than to the sticker controls above it. */}
            <Divider
              label={
                <Group gap={4} wrap="nowrap">
                  Metric visibility
                  <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
                    <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
                      You and moderators still see your real stats on model pages and cards. On
                      search results you see the hidden state, same as the public.
                    </Text>
                  </InfoPopover>
                </Group>
              }
            />

            {isActiveMember ? (
              <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
                <Text size="sm">
                  Controls below this point are for Creator Program members only. They apply while
                  your membership is active and revert if it lapses.
                </Text>
              </Alert>
            ) : (
              membershipUpsell
            )}

            {metricSwitches.map((setting) => (
              <Switch
                key={setting.name}
                name={setting.name}
                label={setting.label}
                description={setting.description}
                checked={setting.checked}
                onChange={(e) => setting.onChange(e.target.checked)}
                disabled={isLoadingSetting || !isActiveMember}
                styles={{ track: { flex: '0 0 1em' } }}
              />
            ))}
          </>
        )}
      </Stack>
    </Card>
  );
}
