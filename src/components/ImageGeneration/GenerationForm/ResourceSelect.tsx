import { Button, ButtonProps, Input, InputWrapperProps } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { useEffect } from 'react';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { openResourceSelectModal } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';

function ResourceSelect({
  value,
  onChange,
  buttonLabel,
  buttonProps,
  options = {},
  allowRemove = true,
  ...inputWrapperProps
}: {
  value?: Generation.Resource;
  onChange?: (value?: Generation.Resource) => void;
  buttonLabel: React.ReactNode;
  buttonProps?: Omit<ButtonProps, 'onClick'>;
  options?: ResourceSelectOptions;
  allowRemove?: boolean;
} & Omit<InputWrapperProps, 'children'>) {
  const types = options.resources?.map((x) => x.type);
  const _value = types && value && !types.includes(value.modelType) ? undefined : value;

  const handleAdd = (resource: Generation.Resource) => {
    onChange?.(resource);
  };

  const handleRemove = () => {
    onChange?.(undefined);
  };

  const handleUpdate = (resource: Generation.Resource) => {
    onChange?.(resource);
  };

  const handleOpenResourceSearch = () => {
    openResourceSelectModal({
      title: buttonLabel,
      onSelect: handleAdd,
      options,
    });
  };

  // removes resources that have unsupported types
  useEffect(() => {
    if (!_value && !!value) onChange?.(_value);
  }, [value]); //eslint-disable-line

  return (
    <Input.Wrapper {...inputWrapperProps}>
      {!value ? (
        <div>
          <Button
            variant="light"
            leftIcon={<IconPlus size={18} />}
            fullWidth
            onClick={handleOpenResourceSearch}
            {...buttonProps}
          >
            {buttonLabel}
          </Button>
        </div>
      ) : (
        <ResourceSelectCard
          resource={value}
          onUpdate={handleUpdate}
          onRemove={allowRemove ? handleRemove : undefined}
          onSwap={handleOpenResourceSearch}
        />
      )}
    </Input.Wrapper>
  );
}

const InputResourceSelect = withController(ResourceSelect, ({ field }) => ({
  value: field.value,
}));
export default InputResourceSelect;
