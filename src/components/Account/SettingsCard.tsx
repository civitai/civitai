import {
  Badge,
  Card,
  Divider,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import produce from 'immer';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useModelFileOptions } from '~/hooks/useModelFileOptions';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
// import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { UserAssistantPersonality } from '~/server/schema/user.schema';
import {
  type FeatureAccess,
  fliptGatedToggleableKeys,
  toggleableFeatures,
} from '~/server/services/feature-flags.service';
import { UNQUANTIZED_QUANT_TYPE } from '~/utils/file-display-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const validModelFormats = constants.modelFileFormats.filter((format) => format !== 'Other');
export const normalizedToggleableFeatures = toggleableFeatures.filter(
  (feature) => feature.key !== 'assistant'
);
export const assistantToggleableFeatures = toggleableFeatures.filter(
  (feature) => feature.key === 'assistant'
);

const mediaFeatureKeys: string[] = ['largerGenerationImages', 'nativeVideoControls'];
export const mediaToggleableFeatures = toggleableFeatures.filter((feature) =>
  mediaFeatureKeys.includes(feature.key)
);

// Denylist, not an allowlist: a flag added to `featureFlags` and routed to no section still shows
// up in Features rather than silently vanishing from the pane.
export const otherToggleableFeatures = normalizedToggleableFeatures.filter(
  (feature) => !mediaFeatureKeys.includes(feature.key)
);

export function SettingsCard() {
  const user = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const flags = useFeatureFlags();
  const { precisions, quantTypes } = useModelFileOptions();

  const { mutate, isPending: isLoading } = trpc.user.update.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await user?.refresh();
      showSuccessNotification({ message: 'User profile updated' });
    },
  });

  const { assistantPersonality } = useCurrentUserSettings();
  const { mutate: mutateSetting, isPending: isLoadingSetting } = useMutateUserSettings();

  if (!user) return null;

  return (
    <Card withBorder id="settings">
      <Stack>
        <Title order={2}>Browsing Settings</Title>

        <Divider label="Image Preferences" mb={-12} />
        <Group wrap="nowrap" grow>
          <AutoplayGifsToggle />
          <Select
            label="Preferred Format"
            name="imageFormat"
            data={[
              {
                value: 'optimized',
                label: 'Optimized (avif, webp)',
              },
              {
                value: 'metadata',
                label: 'Unoptimized (jpeg, png)',
              },
            ]}
            value={user.filePreferences?.imageFormat ?? 'metadata'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, imageFormat: value as ImageFormat },
              })
            }
            disabled={isLoading}
          />
        </Group>
        <SwipeGalleryCardsToggle />
        <StickerMotionToggle />

        <Divider label="Model File Preferences" mb={-12} />
        <Group wrap="nowrap" grow>
          <Select
            label="Preferred Format"
            name="fileFormat"
            data={validModelFormats}
            value={user.filePreferences?.format ?? 'SafeTensor'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, format: value as ModelFileFormat },
              })
            }
            disabled={isLoading}
          />
          <Select
            label="Preferred Precision"
            // name="fp"
            data={precisions.map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
            value={user.filePreferences?.fp ?? 'fp16'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, fp: value as ModelFileFp },
              })
            }
            disabled={isLoading}
          />
        </Group>
        {user.filePreferences?.format === 'GGUF' && (
          <Tooltip
            label="Quant type determines the quality/size tradeoff. Q8_0 has the best quality but largest size, Q4_K_M provides a good balance, Q2_K is smallest but lower quality."
            multiline
            w={300}
          >
            <Select
              label="Preferred Quant Type"
              name="quantType"
              // "Unquantized" isn't a meaningful download preference; leaving this unset is.
              data={quantTypes.filter((x) => x !== UNQUANTIZED_QUANT_TYPE)}
              allowDeselect={false}
              value={user.filePreferences?.quantType ?? 'Q4_K_M'}
              onChange={(value: string | null) =>
                mutate({
                  id: user.id,
                  filePreferences: {
                    ...user.filePreferences,
                    quantType: value as ModelFileQuantType,
                  },
                })
              }
              disabled={isLoading}
            />
          </Tooltip>
        )}

        {!!assistantToggleableFeatures && (
          <>
            <Divider label="Assistant Preferences" />
            <Stack>
              <ToggleableFeatures data={assistantToggleableFeatures} />
              <Tooltip
                withArrow
                offset={-10}
                label={!flags.assistantPersonality ? 'Available to subscribers only' : undefined}
                disabled={flags.assistantPersonality}
              >
                <div>
                  <Select
                    label={
                      <Group mb={4} gap="xs">
                        <Text size="sm" fw={500}>
                          Personality
                        </Text>
                        {new Date() < new Date('2025-04-21') && <Badge color="green">New</Badge>}
                      </Group>
                    }
                    name="assistantPersonality"
                    disabled={isLoadingSetting || !flags.assistantPersonality}
                    data={[
                      {
                        value: 'civbot',
                        label: 'CivBot',
                      },
                      {
                        value: 'civchan',
                        label: 'CivChan',
                      },
                    ]}
                    value={assistantPersonality ?? 'civbot'}
                    onChange={(value: string | null) => {
                      if (flags.assistantPersonality) {
                        mutateSetting({ assistantPersonality: value as UserAssistantPersonality });
                      }
                    }}
                  />
                </div>
              </Tooltip>
            </Stack>
          </>
        )}

        {flags.buzz && (
          <>
            <Divider label="Buzz Preferences" mb={-12} />
            <HideBlueBuzzToggle />
          </>
        )}

        <Divider label="Features" />
        <EarlyAdopterToggle />
        {normalizedToggleableFeatures.length > 0 && (
          <ToggleableFeatures data={normalizedToggleableFeatures} />
        )}
      </Stack>
    </Card>
  );
}

export function AutoplayGifsToggle() {
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  const setState = useBrowsingSettings((x) => x.setState);

  return (
    <Switch
      name="autoplayGifs"
      label="Autoplay GIFs"
      checked={autoplayGifs}
      onChange={(e) => setState({ autoplayGifs: e.target.checked })}
    />
  );
}

export function SwipeGalleryCardsToggle() {
  const { swipeGalleryCards } = useCurrentUserSettings();
  const { mutate, isPending } = useMutateUserSettings();

  return (
    <Switch
      name="swipeGalleryCards"
      label="Swipe between images on gallery cards"
      description="Swipe through a post's images instead of using the arrows."
      checked={swipeGalleryCards ?? false}
      disabled={isPending}
      onChange={(e) => mutate({ swipeGalleryCards: e.target.checked })}
      styles={{ track: { flex: '0 0 1em' } }}
    />
  );
}

export function StickerMotionToggle() {
  const features = useFeatureFlags();
  const { disableStickerMotion } = useCurrentUserSettings();
  const { mutate, isPending } = useMutateUserSettings();

  // Nothing animates until placement ships, so until then this is a switch over
  // a thing that does not happen — and the only way to find that out is to turn
  // it off and see no difference.
  if (!features.stickerPlacement) return null;

  return (
    <Switch
      name="stickerMotion"
      label="Animate stickers placed on images"
      description="Off keeps them still; they stay visible either way."
      // Stored as an opt-out so the default costs no row, and so a creator who
      // never opens this page gets the animation rather than a silent no.
      checked={!(disableStickerMotion ?? false)}
      disabled={isPending}
      onChange={(e) => mutate({ disableStickerMotion: !e.target.checked })}
      styles={{ track: { flex: '0 0 1em' } }}
    />
  );
}

export function HideBlueBuzzToggle() {
  const { hideBlueBuzzInHeader } = useCurrentUserSettings();
  const { mutate, isPending } = useMutateUserSettings();

  return (
    <Switch
      name="hideBlueBuzzInHeader"
      label="Hide Blue Buzz in the header"
      description="Leaves it out of the header balance. You can still spend it."
      checked={hideBlueBuzzInHeader ?? false}
      disabled={isPending}
      onChange={(e) => mutate({ hideBlueBuzzInHeader: e.target.checked })}
      styles={{ track: { flex: '0 0 1em' } }}
    />
  );
}

export function EarlyAdopterToggle() {
  const { isEarlyAdopter } = useCurrentUserSettings();
  const currentUser = useCurrentUser();
  // The value is carried on the SESSION (see user.schema `isEarlyAdopter`), and the server
  // busts the shared session cache on change. Re-pull the session here too so this tab's
  // own `SessionUser` — and therefore its Flipt context — updates without a reload, rather
  // than waiting on the `session:refresh` signal. Mirrors CreatorProgramV2, which does the
  // same belt-and-braces refresh at the call site.
  const { mutate, isPending } = useMutateUserSettings({
    onSuccess: () => {
      currentUser?.refresh();
    },
  });

  return (
    <Switch
      name="isEarlyAdopter"
      label="Join the early-adopter program"
      description="Features before they roll out. They may be rough or change without notice."
      checked={isEarlyAdopter ?? false}
      disabled={isPending}
      onChange={(e) => mutate({ isEarlyAdopter: e.target.checked })}
      styles={{ track: { flex: '0 0 1em' } }}
    />
  );
}

export function ToggleableFeatures({ data }: { data: typeof toggleableFeatures }) {
  const flags = useFeatureFlags();
  const queryUtils = trpc.useUtils();
  // Flipt-gated toggles only exist for granted users: the overlay withholds the key for everyone
  // else, so its absence distinguishes "not granted" (hide the row) from "toggled off" (show it).
  const { data: userFeatures } = trpc.user.getFeatureFlags.useQuery(undefined, {
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const visible = data.filter(
    (feature) =>
      !fliptGatedToggleableKeys.has(feature.key) || (userFeatures && feature.key in userFeatures)
  );
  const toggleFeatureFlagMutation = trpc.user.toggleFeature.useMutation({
    async onMutate(payload) {
      await queryUtils.user.getFeatureFlags.cancel();
      const prevData = queryUtils.user.getFeatureFlags.getData();

      queryUtils.user.getFeatureFlags.setData(
        undefined,
        produce((old) => {
          if (!old) return;
          old[payload.feature] = payload.value ?? !old[payload.feature];
        })
      );

      return { prevData };
    },
    async onSuccess() {
      await queryUtils.user.getFeatureFlags.invalidate();
    },
    onError(_error, _payload, context) {
      showErrorNotification({
        title: 'Failed to toggle feature',
        error: new Error('Something went wrong, please try again later.'),
      });
      queryUtils.user.getFeatureFlags.setData(undefined, context?.prevData);
    },
  });

  function toggleFlag(key: keyof FeatureAccess, value: boolean) {
    toggleFeatureFlagMutation.mutate({ feature: key, value });
  }

  return (
    <>
      {visible.map((feature) => (
        <Switch
          name={feature.key}
          key={feature.key}
          label={feature.displayName}
          checked={flags[feature.key]}
          onChange={(e) => toggleFlag(feature.key, e.target.checked)}
          description={feature.description}
          styles={{ track: { flex: '0 0 1em' } }}
        />
      ))}
    </>
  );
}

/**
 * The selects below are exported so the flat settings panes and the legacy card render the same
 * control rather than two copies that can drift while the `accountSettingsV2` flag is alive.
 * They carry no label of their own — the pane's `SettingRow` supplies it.
 */
function useFilePreferenceUpdate() {
  const user = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { mutate, isPending } = trpc.user.update.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await user?.refresh();
      showSuccessNotification({ message: 'User profile updated' });
    },
  });

  const update = (filePreferences: Record<string, unknown>) => {
    if (!user) return;
    mutate({ id: user.id, filePreferences: { ...user.filePreferences, ...filePreferences } });
  };

  return { user, update, isPending };
}

export function ImageFormatSelect() {
  const { user, update, isPending } = useFilePreferenceUpdate();
  if (!user) return null;
  return (
    <Select
      aria-label="Preferred image format"
      data={[
        { value: 'optimized', label: 'Optimized (avif, webp)' },
        { value: 'metadata', label: 'Unoptimized (jpeg, png)' },
      ]}
      value={user.filePreferences?.imageFormat ?? 'metadata'}
      onChange={(value: string | null) => update({ imageFormat: value })}
      disabled={isPending}
    />
  );
}

export function ModelFileFormatSelect() {
  const { user, update, isPending } = useFilePreferenceUpdate();
  if (!user) return null;
  return (
    <Select
      aria-label="Preferred model file format"
      data={validModelFormats}
      value={user.filePreferences?.format ?? 'SafeTensor'}
      onChange={(value: string | null) => update({ format: value })}
      disabled={isPending}
    />
  );
}

export function ModelPrecisionSelect() {
  const { user, update, isPending } = useFilePreferenceUpdate();
  const { precisions } = useModelFileOptions();
  if (!user) return null;
  return (
    <Select
      aria-label="Preferred precision"
      data={precisions.map((value) => ({ value, label: value.toUpperCase() }))}
      value={user.filePreferences?.fp ?? 'fp16'}
      onChange={(value: string | null) => update({ fp: value })}
      disabled={isPending}
    />
  );
}

/** Only meaningful for GGUF, which is the one format that ships quantised builds. */
export function ModelQuantTypeSelect() {
  const { user, update, isPending } = useFilePreferenceUpdate();
  const { quantTypes } = useModelFileOptions();
  if (!user || user.filePreferences?.format !== 'GGUF') return null;
  return (
    <Select
      aria-label="Preferred quant type"
      data={quantTypes.filter((x) => x !== UNQUANTIZED_QUANT_TYPE)}
      allowDeselect={false}
      value={user.filePreferences?.quantType ?? 'Q4_K_M'}
      onChange={(value: string | null) => update({ quantType: value })}
      disabled={isPending}
    />
  );
}

export function AssistantPersonalitySelect() {
  const flags = useFeatureFlags();
  const { assistantPersonality } = useCurrentUserSettings();
  const { mutate, isPending } = useMutateUserSettings();

  return (
    <Tooltip
      withArrow
      label="Available to subscribers only"
      disabled={flags.assistantPersonality}
      offset={-10}
    >
      <div>
        <Select
          aria-label="Assistant personality"
          disabled={isPending || !flags.assistantPersonality}
          data={[
            { value: 'civbot', label: 'CivBot' },
            { value: 'civchan', label: 'CivChan' },
          ]}
          value={assistantPersonality ?? 'civbot'}
          onChange={(value: string | null) => {
            if (flags.assistantPersonality)
              mutate({ assistantPersonality: value as UserAssistantPersonality });
          }}
        />
      </div>
    </Tooltip>
  );
}
