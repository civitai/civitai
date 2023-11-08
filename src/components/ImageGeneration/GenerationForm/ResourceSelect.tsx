import { Button, ButtonProps, Input, InputWrapperProps } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconPlus } from '@tabler/icons-react';
import React, { useEffect } from 'react';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { openResourceSelectModal } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';

function ResourceSelect({
  value,
  onChange,
  buttonLabel,
  buttonProps,
  options = {},
  ...inputWrapperProps
}: {
  value?: Generation.Resource;
  onChange?: (value?: Generation.Resource) => void;
  buttonLabel: React.ReactNode;
  buttonProps?: Omit<ButtonProps, 'onClick'>;
  options?: {
    baseModel?: string;
    type?: ModelType;
    canGenerate?: boolean;
  };
} & Omit<InputWrapperProps, 'children'>) {
  const { type } = options;
  const _value = type && type !== value?.modelType ? undefined : value;
  const canAdd = !_value;

  const handleAdd = (resource: Generation.Resource) => {
    if (!canAdd) return;
    onChange?.(resource);
  };

  const handleRemove = () => {
    onChange?.(undefined);
  };

  const handleUpdate = (resource: Generation.Resource) => {
    onChange?.(resource);
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
            onClick={() =>
              openResourceSelectModal({
                title: buttonLabel,
                onSelect: handleAdd,
                options: {
                  ...options,
                  types: type ? [type] : undefined,
                },
              })
            }
            {...buttonProps}
          >
            {buttonLabel}
          </Button>
        </div>
      ) : (
        <ResourceSelectCard resource={value} onUpdate={handleUpdate} onRemove={handleRemove} />
      )}
    </Input.Wrapper>
  );
}

const InputResourceSelect = withController(ResourceSelect, ({ field }) => ({
  value: field.value,
}));
export default InputResourceSelect;
