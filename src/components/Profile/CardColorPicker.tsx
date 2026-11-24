import {
  ColorPicker,
  ColorSwatch,
  Group,
  Input,
  SegmentedControl,
  Slider,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { Popover, Tooltip } from '~/components/MantineOverlays';
import { IconBan, IconMoon, IconPlus, IconSun } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import {
  profileCardBackground,
  profileCardInk,
  suggestedCardColor,
} from '~/components/Profile/profile-card-color';
import type { ProfilePageTheme, ProfileThemeMode } from '~/server/schema/user-profile.schema';
import { profileCardOpacityDefault } from '~/server/schema/user-profile.schema';

type Mode = ProfileThemeMode;
type HashedImage = { hash?: string | null } | null | undefined;

// A few tried colours beside the ones taken from the member's own images.
const presets = ['#1b2a4a', '#2b3a2e', '#3d2c5c', '#f3ead7', '#d9e8f5', '#f6dfe5'];

/** The theme's own panel colour, used at the chosen opacity when no colour is picked. */
const themePanel: Record<Mode, string> = { dark: '#25262b', light: '#ffffff' };

/** The theme surface a card sits on, for the preview. */
const surface: Record<Mode, string> = { dark: '#1a1b1e', light: '#f1f3f5' };

const hexPattern = /^#[0-9a-f]{6}$/i;

/**
 * Card colour and opacity for each theme (members only, profile redesign): a live preview, swatches
 * from the member's banner and background plus a few presets, and a full picker behind "+". The
 * light-mode pair falls back to the dark-mode one when it is not set.
 */
export function CardColorPicker({
  value,
  cover,
  background,
  onChange,
}: {
  value: ProfilePageTheme | null;
  cover: HashedImage;
  background: HashedImage;
  onChange: (next: ProfilePageTheme | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('dark');
  const [pickerOpen, setPickerOpen] = useState(false);
  const own = value?.[mode];
  const ownColor = own?.color ?? null;
  // What visitors in this theme see: light mode inherits the dark colours until it has its own.
  const inherits = mode === 'light' && !own;
  const shown = inherits ? value?.dark : own;
  const color = shown?.color ?? null;
  const opacity = shown?.opacity ?? profileCardOpacityDefault;

  // Writes this theme's colours; clearing the last one stores nothing at all.
  const setTheme = (next: ProfilePageTheme[Mode] | undefined) => {
    const theme = { ...value, [mode]: next };
    if (!theme[mode]) delete theme[mode];
    onChange(theme.dark || theme.light ? theme : null);
  };

  const suggestions = [
    { label: 'From your banner', color: suggestedCardColor(cover?.hash) },
    { label: 'From your background', color: suggestedCardColor(background?.hash) },
  ].filter((suggestion): suggestion is { label: string; color: string } => !!suggestion.color);
  const swatches = [
    ...suggestions,
    ...presets.map((preset) => ({ label: preset, color: preset })),
  ].filter((swatch, i, all) => all.findIndex((other) => other.color === swatch.color) === i);
  const isCustom = !!ownColor && !swatches.some((swatch) => swatch.color === ownColor);

  // Clearing the colour keeps a chosen opacity, which then applies to the theme's own panel colour.
  const setColor = (next: string | null) =>
    setTheme(
      next
        ? { color: next, opacity: own?.opacity }
        : own?.opacity != null
        ? { opacity: own.opacity }
        : undefined
    );
  // Without a colour the preview is the theme's own card, with the theme's own text.
  const ink = profileCardInk(color, opacity, mode) ?? (mode === 'dark' ? 'light' : 'dark');

  return (
    <Input.Wrapper
      label="Card colour"
      description="Tints your profile's panels, sidebar and tabs. Text switches to stay readable."
    >
      <Stack gap="sm" mt={6}>
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(value) => setMode(value as Mode)}
          data={[
            {
              value: 'dark',
              label: (
                <Group gap={6} justify="center" wrap="nowrap">
                  <IconMoon size={14} /> Dark mode
                </Group>
              ),
            },
            {
              value: 'light',
              label: (
                <Group gap={6} justify="center" wrap="nowrap">
                  <IconSun size={14} /> Light mode
                </Group>
              ),
            },
          ]}
        />

        <Group align="stretch" gap="md" wrap="nowrap">
          {/* Preview: the card as visitors in this theme see it. */}
          <div
            className="flex w-32 shrink-0 items-center justify-center rounded-md p-2"
            style={{ background: surface[mode] }}
            aria-hidden
          >
            <div
              className={clsx(
                'flex w-full flex-col gap-1 rounded border px-2 py-1.5',
                mode === 'dark' ? 'border-dark-4' : 'border-gray-3'
              )}
              style={{
                background: profileCardBackground(color ?? themePanel[mode], opacity),
                color: ink === 'dark' ? '#212529' : '#f1f3f5',
              }}
            >
              <Text size="xs" fw={700} c="inherit" lh={1.2}>
                Showcase
              </Text>
              <Text size="10px" c="inherit" opacity={0.7} lh={1.2}>
                Your panels
              </Text>
            </div>
          </div>

          <Stack gap={8} className="min-w-0 flex-1">
            <Group gap={8}>
              <Tooltip label={mode === 'light' ? 'Same as dark mode' : "The theme's colour"}>
                <UnstyledButton
                  onClick={() => setColor(null)}
                  aria-label={mode === 'light' ? 'Same as dark mode' : "Use the theme's colour"}
                  className={clsx(
                    'flex size-7 items-center justify-center rounded-full border border-gray-4 dark:border-dark-3',
                    ownColor == null && 'ring-2 ring-blue-5 ring-offset-2 ring-offset-transparent'
                  )}
                >
                  <IconBan size={14} className="text-gray-6 dark:text-dark-2" />
                </UnstyledButton>
              </Tooltip>
              {swatches.map((swatch) => (
                <Tooltip key={swatch.label} label={swatch.label}>
                  <UnstyledButton
                    onClick={() => setColor(swatch.color)}
                    aria-label={swatch.label}
                    className={clsx(
                      'rounded-full',
                      ownColor === swatch.color &&
                        'ring-2 ring-blue-5 ring-offset-2 ring-offset-transparent'
                    )}
                  >
                    <ColorSwatch color={swatch.color} size={28} />
                  </UnstyledButton>
                </Tooltip>
              ))}
              <Popover
                opened={pickerOpen}
                onChange={setPickerOpen}
                position="bottom-end"
                shadow="md"
                withinPortal
              >
                <Popover.Target>
                  <Tooltip label="Pick any colour">
                    <UnstyledButton
                      onClick={() => setPickerOpen((open) => !open)}
                      aria-label="Pick any colour"
                      className={clsx(
                        'flex size-7 items-center justify-center rounded-full border border-dashed border-gray-5 dark:border-dark-2',
                        isCustom && 'ring-2 ring-blue-5 ring-offset-2 ring-offset-transparent'
                      )}
                      style={isCustom ? { background: ownColor ?? undefined } : undefined}
                    >
                      {!isCustom && <IconPlus size={14} />}
                    </UnstyledButton>
                  </Tooltip>
                </Popover.Target>
                <Popover.Dropdown>
                  <CustomColor value={ownColor} onChange={setColor} />
                </Popover.Dropdown>
              </Popover>
            </Group>
            {inherits && value?.dark && (
              <Text size="xs" c="dimmed">
                Light mode uses your dark-mode colour until you pick one here.
              </Text>
            )}
            {suggestions.length > 0 && (
              <Text size="xs" c="dimmed">
                The first {suggestions.length === 1 ? 'swatch is' : 'swatches are'} taken from your{' '}
                {suggestions.map((s) => s.label.replace('From your ', '')).join(' and ')}.
              </Text>
            )}
          </Stack>
        </Group>

        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm">Opacity</Text>
            <Text size="sm" c="dimmed">
              {opacity}%
            </Text>
          </Group>
          <Slider
            min={60}
            max={100}
            step={5}
            value={opacity}
            onChange={(next) => {
              // In light mode this gives light its own colours, starting from the dark ones.
              setTheme({ ...(color && { color }), opacity: next });
            }}
            marks={[{ value: 60 }, { value: 80 }, { value: 100 }]}
            label={null}
          />
        </div>
      </Stack>
    </Input.Wrapper>
  );
}

function CustomColor({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  return (
    <Stack gap="xs" w={220}>
      <ColorPicker
        format="hex"
        value={value ?? '#2b3a2e'}
        onChange={(next) => {
          setDraft(next);
          onChange(next);
        }}
        fullWidth
      />
      <TextInput
        size="xs"
        label="Hex"
        value={draft}
        placeholder="#1b2a4a"
        onChange={(event) => {
          const next = event.currentTarget.value.trim();
          setDraft(next);
          if (hexPattern.test(next)) onChange(next.toLowerCase());
        }}
        error={draft && !hexPattern.test(draft) ? 'Use #rrggbb' : undefined}
      />
    </Stack>
  );
}
