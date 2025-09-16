import { CloseButton, List, Modal, Text, Title, Switch, Button, Popover } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import { IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useUserSettings } from '~/providers/UserSettingsProvider';

type GenerationKeys = keyof UserSettingsSchema['generation'];
type GenerationSettingOption = {
  key: GenerationKeys;
  label: string;
  description: string;
  info?: VoidFunction;
};

const options: GenerationSettingOption[] = [
  {
    key: 'advancedMode',
    label: 'Advanced Mode',
    description: 'Allow unrestricted mixing of additional resources and base models.',
    info: openAdvancedModeModal,
  } as GenerationSettingOption,
];

export function GenerationSettings() {
  return (
    <div className="flex flex-col gap-4">
      {options.map((option) => (
        <GenerationSettingsOption key={option.key} option={option} />
      ))}
    </div>
  );
}

function GenerationSettingsOption({
  option,
  onSuccess,
}: {
  option: GenerationSettingOption;
  onSuccess?: VoidFunction;
}) {
  const generation = useUserSettings((x) => x.generation ?? {});
  const setState = useUserSettings((x) => x.setState);

  function toggleSetting(key: GenerationKeys, value: boolean) {
    setState((state) => ({ generation: { ...state.generation, [key]: value } }));
    onSuccess?.();
  }

  return (
    <Switch
      label={
        <div className="flex items-center gap-1">
          <span>{option.label}</span>
          {option.info && (
            <LegacyActionIcon onClick={option.info} size="sm">
              <IconInfoCircle size={16} />
            </LegacyActionIcon>
          )}
        </div>
      }
      checked={generation[option.key]}
      onChange={(e) => toggleSetting(option.key, e.target.checked)}
      description={option.description}
      styles={{ track: { flex: '0 0 1em' } }}
    />
  );
}

function openAdvancedModeModal() {
  dialogStore.trigger({
    id: 'advanced-mode-modal',
    component: AdvancedModeModal,
  });
}

function AdvancedModeModal() {
  const dialog = useDialogContext();
  const generation = useUserSettings((x) => x.generation ?? {});
  const setState = useUserSettings((x) => x.setState);
  const hasSetAdvancedMode = 'advancedMode' in generation;
  const toggleOptionRef = useRef<GenerationSettingOption | null>(null);
  if (!toggleOptionRef.current)
    toggleOptionRef.current = !hasSetAdvancedMode
      ? options.find((x) => x.key === 'advancedMode') ?? null
      : null;

  function handleClose() {
    dialog.onClose();
    if (!hasSetAdvancedMode)
      setState((state) => ({ generation: { ...state.generation, advancedMode: false } }));
  }

  return (
    <Modal {...dialog} onClose={handleClose} withCloseButton={false}>
      <CloseButton onClick={handleClose} className="absolute right-1 top-1" />
      <div className="flex flex-col gap-3">
        <Title>Model Compatibility</Title>
        <Text>
          Some resources work well together, while others may produce unexpected or lower-quality
          results.
        </Text>
        <div>
          <Text>Enabling Advanced Mode lets you freely combine resources, but:</Text>
          <List>
            <List.Item>Results may vary, and quality is not guaranteed.</List.Item>
            <List.Item>
              {`Refunds won't be given for poor results caused by incompatible resources.`}
            </List.Item>
          </List>
        </div>
        {toggleOptionRef.current && (
          <>
            <Text>
              To continue using our recommended combinations, simply close this window. You can
              switch to Advanced Mode at any time in Settings.
            </Text>
            <GenerationSettingsOption
              option={{ ...toggleOptionRef.current, info: undefined }}
              onSuccess={() => dialog.onClose()}
            />
          </>
        )}
        <Button onClick={handleClose} className="mt-3">
          Close
        </Button>
      </div>
    </Modal>
  );
}

export function GenerationSettingsPopover({ children }: { children: React.ReactElement }) {
  const generation = useUserSettings((x) => x.generation ?? {});

  useEffect(() => {
    if (generation.advancedMode === undefined) openAdvancedModeModal();
  }, [generation.advancedMode]);

  return (
    <Popover withArrow position="bottom-end">
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <GenerationSettings />
      </Popover.Dropdown>
    </Popover>
  );
}
