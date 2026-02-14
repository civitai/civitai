import type { ButtonProps, GroupProps, InputWrapperProps } from '@mantine/core';
import { Button, Input } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef, useEffect } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { withController } from '~/libs/form/hoc/withController';
import type { GenerationResource } from '~/shared/types/generation.types';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
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
  disabled?: boolean;
  isPreview?: boolean;
};

export const ResourceSelect = forwardRef<HTMLDivElement, Props>(
  (
    {
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
      isPreview,
      ...inputWrapperProps
    },
    ref
  ) => {
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
          <div ref={ref}>
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
            isPreview={isPreview}
          />
        )}
      </Input.Wrapper>
    );
  }
);

ResourceSelect.displayName = 'ResourceSelect';

const InputResourceSelect = withController(ResourceSelect, ({ field }) => ({
  value: field.value,
}));
export default InputResourceSelect;
