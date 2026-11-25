import { ColorSwatch, Group, Input, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconBan, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { Popover, Tooltip } from '~/components/MantineOverlays';
import { CustomColor } from '~/components/Profile/CardColorPicker';
import {
  darkenHex,
  profileCardInk,
  suggestedCardColor,
} from '~/components/Profile/profile-card-color';

type HashedImage = { hash?: string | null } | null | undefined;

// Dark tones: the sidebar sits darker than the page, with the name and buttons on it.
const presets = ['#1b2a4a', '#2b3a2e', '#3d2c5c', '#4a2333', '#3b2f24', '#24343a'];
// The default dark base, as in ProfileLayout2's sidebar class (rgb(28 29 32)).
const defaultSidebar = '#1c1d20';
const selectedRing = 'ring-2 ring-blue-5 ring-offset-2 ring-offset-transparent';

/**
 * The sidebar's own colour (members only, profile redesign), apart from the card colour: a
 * preview of the sidebar's gradient, the default dark, darkened colours from the member's banner
 * and background, a few dark presets, and any colour behind "+".
 */
export function SidebarColorPicker({
  value,
  cover,
  background,
  onChange,
}: {
  value: string | null;
  cover: HashedImage;
  background: HashedImage;
  onChange: (color: string | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const fromImage = (hash?: string | null) => {
    const color = suggestedCardColor(hash);
    return color ? darkenHex(color, 0.55) : null;
  };
  const suggestions = [
    { label: 'From your banner', color: fromImage(cover?.hash) },
    { label: 'From your background', color: fromImage(background?.hash) },
  ].filter((suggestion): suggestion is { label: string; color: string } => !!suggestion.color);
  const swatches = [...suggestions, ...presets.map((color) => ({ label: color, color }))].filter(
    (swatch, i, all) => all.findIndex((other) => other.color === swatch.color) === i
  );
  const isCustom = !!value && !swatches.some((swatch) => swatch.color === value);
  const shown = value ?? defaultSidebar;
  const ink = profileCardInk(shown, 100, 'dark') === 'dark' ? '#212529' : '#f1f3f5';

  return (
    <Input.Wrapper
      label="Sidebar colour"
      description="The sidebar darkens towards the bottom from this colour. Your sidebar background shows above it."
    >
      <Group align="stretch" gap="md" wrap="nowrap" mt={6}>
        <div
          aria-hidden
          className="flex h-24 w-20 shrink-0 flex-col items-center gap-1.5 rounded-md border border-dark-4 pt-3"
          style={{
            background: `linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.45)),${shown}`,
            color: ink,
          }}
        >
          <div className="size-8 rounded-full bg-gray-5" />
          <Text size="10px" fw={700} c="inherit">
            Your name
          </Text>
        </div>
        <Stack gap={8} className="min-w-0 flex-1">
          <Group gap={8}>
            <Tooltip label="The default dark">
              <UnstyledButton
                onClick={() => onChange(null)}
                aria-label="Use the default dark"
                className={clsx(
                  'flex size-7 items-center justify-center rounded-full border border-gray-4 dark:border-dark-3',
                  value == null && selectedRing
                )}
              >
                <IconBan size={14} className="text-gray-6 dark:text-dark-2" />
              </UnstyledButton>
            </Tooltip>
            {swatches.map((swatch) => (
              <Tooltip key={swatch.label} label={swatch.label}>
                <UnstyledButton
                  onClick={() => onChange(swatch.color)}
                  aria-label={swatch.label}
                  className={clsx('rounded-full', value === swatch.color && selectedRing)}
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
                      isCustom && selectedRing
                    )}
                    style={isCustom ? { background: value ?? undefined } : undefined}
                  >
                    {!isCustom && <IconPlus size={14} />}
                  </UnstyledButton>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <CustomColor fallback={defaultSidebar} value={value} onChange={onChange} />
              </Popover.Dropdown>
            </Popover>
          </Group>
          {suggestions.length > 0 && (
            <Text size="xs" c="dimmed">
              The first {suggestions.length === 1 ? 'swatch is' : 'swatches are'} taken from your{' '}
              {suggestions.map((s) => s.label.replace('From your ', '')).join(' and ')}, darkened.
            </Text>
          )}
        </Stack>
      </Group>
    </Input.Wrapper>
  );
}
