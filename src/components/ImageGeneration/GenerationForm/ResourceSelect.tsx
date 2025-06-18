import type { ButtonProps, GroupProps, InputWrapperProps } from '@mantine/core';
import { Button, Input } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { useEffect } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/dialog-registry';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { withController } from '~/libs/form/hoc/withController';
import type { GenerationResource } from '~/server/services/generation/generation.service';

export const ResourceSelect = ({
  value,
  onChange,
  buttonLabel,
  modalTitle,
  buttonProps,
  options = {},
  allowRemove = true,
  selectSource = 'generation',
  disabled,
  hideVersion,
  groupPosition,
  showAsCheckpoint,
  ...inputWrapperProps
}: {
  value?: GenerationResource | null;
  onChange?: (value: GenerationResource | null) => void;
  buttonLabel: React.ReactNode;
  modalTitle?: React.ReactNode;
  buttonProps?: Omit<ButtonProps, 'onClick'>;
  options?: ResourceSelectOptions;
  allowRemove?: boolean;
  selectSource?: ResourceSelectSource;
  hideVersion?: boolean;
  groupPosition?: GroupProps['justify'];
  showAsCheckpoint?: boolean;
} & Omit<InputWrapperProps, 'children' | 'onChange'> & { disabled?: boolean }) => {
  const types = options.resources?.map((x) => x.type);
  const _value = types && value && !types.includes(value.model.type) ? undefined : value;

  function handleChange(resource?: GenerationResource | null) {
    if (
      selectSource === 'generation' &&
      resource &&
      !resource.canGenerate &&
      resource.substitute?.canGenerate
    ) {
      onChange?.({ ...resource, ...resource.substitute });
    } else {
      onChange?.(resource ?? null);
    }
  }

  const handleRemove = () => {
    handleChange(undefined);
  };

  const handleOpenResourceSearch = () => {
    openResourceSelectModal({
      title: modalTitle ?? buttonLabel,
      onSelect: handleChange,
      options,
      selectSource,
    });
  };

  // removes resources that have unsupported types
  useEffect(() => {
    if (!_value && !!value) onChange?.(_value ?? null);
  }, [value]); //eslint-disable-line

  return (
    <Input.Wrapper {...inputWrapperProps}>
      {!value ? (
        <div>
          <Button
            variant="light"
            leftSection={<IconPlus size={18} />}
            fullWidth
            onClick={handleOpenResourceSearch}
            disabled={disabled}
            {...buttonProps}
          >
            {buttonLabel}
          </Button>
        </div>
      ) : (
        <ResourceSelectCard
          resource={value}
          selectSource={selectSource}
          onUpdate={handleChange}
          onRemove={allowRemove ? handleRemove : undefined}
          onSwap={handleOpenResourceSearch}
          hideVersion={hideVersion}
          groupPosition={groupPosition}
          showAsCheckpoint={showAsCheckpoint}
        />
      )}
    </Input.Wrapper>
  );
};

const InputResourceSelect = withController(ResourceSelect, ({ field }) => ({
  value: field.value,
}));
export default InputResourceSelect;
