import { Button, ButtonProps, Divider, Input, InputWrapperProps, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef, useEffect } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/dialog-registry';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';
import { getDisplayName } from '~/utils/string-helpers';
import { ResourceSelectOptions } from './resource-select.types';

type ResourceSelectMultipleProps = {
  limit?: number;
  value?: Generation.Resource[];
  onChange?: (value?: Generation.Resource[]) => void;
  buttonLabel: React.ReactNode;
  buttonProps?: Omit<ButtonProps, 'onClick'>;
  options?: ResourceSelectOptions;
  modalOpened?: boolean;
  onCloseModal?: () => void;
  hideButton?: boolean;
  isTraining?: boolean;
} & Omit<InputWrapperProps, 'children'>;

export const ResourceSelectMultiple = forwardRef<HTMLDivElement, ResourceSelectMultipleProps>(
  (
    {
      limit,
      value = [],
      onChange,
      buttonLabel,
      buttonProps,
      options = {},
      modalOpened,
      onCloseModal,
      hideButton = false,
      isTraining = false,
      ...inputWrapperProps
    },
    ref
  ) => {
    // const { types } = options;
    const types = options.resources?.map((x) => x.type);

    // _types used to set up groups
    const _types = types ?? [...new Set(value?.map((x) => x.modelType))];
    const _values = types ? [...value].filter((x) => types.includes(x.modelType)) : value;
    const groups = _types
      .map((type) => ({
        type,
        label: getDisplayName(type),
        resources: _values.filter((x) => x.modelType === type),
      }))
      .filter((x) => !!x.resources.length);
    const canAdd = !limit || _values.length < limit;

    const handleAdd = (resource: Generation.Resource) => {
      if (!canAdd) return;
      onChange?.([..._values, resource]);
      onCloseModal?.();
    };

    const handleRemove = (id: number) => {
      const filtered = [..._values.filter((x) => x.id !== id)];
      // const emitValue = !!filtered.length ? filtered : undefined;
      onChange?.(filtered);
    };

    const handleUpdate = (resource: Generation.Resource) => {
      const index = _values.findIndex((x) => x.id === resource.id);
      if (index > -1) {
        const emitValue = [..._values];
        emitValue[index] = resource;
        onChange?.(emitValue);
      }
    };

    // removes resources that have unsupported types
    useEffect(() => {
      if (_values.length !== value.length) onChange?.(_values.length ? _values : undefined);
    }, [value]); //eslint-disable-line

    const handleOpenModal = () => {
      openResourceSelectModal({
        title: buttonLabel,
        onSelect: handleAdd,
        options,
        onClose: onCloseModal,
      });
    };

    useEffect(() => {
      if (modalOpened) handleOpenModal();
    }, [modalOpened]);

    // Made with copilot :^) -Manuel
    const sortedGroups = [...groups].sort((a, b) => {
      const aIndex = types?.indexOf(a.type);
      const bIndex = types?.indexOf(b.type);
      if (aIndex === undefined || bIndex === undefined) return 0;
      return aIndex - bIndex;
    });

    return (
      <Input.Wrapper {...inputWrapperProps} descriptionProps={{ mb: 8 }} ref={ref}>
        <Stack spacing="md" mb={inputWrapperProps.error ? 5 : undefined}>
          {sortedGroups.map((group, index) => {
            return (
              <React.Fragment key={group.type}>
                {index !== 0 && <Divider />}
                <Input.Wrapper
                  label={
                    <Text color="dark.2" weight={590}>
                      {group.label}
                    </Text>
                  }
                  labelProps={{ mb: 8 }}
                >
                  <Stack spacing={8}>
                    {group.resources.map((resource) => (
                      <ResourceSelectCard
                        key={resource.id}
                        resource={resource}
                        isTraining={isTraining}
                        onUpdate={handleUpdate}
                        onRemove={handleRemove}
                      />
                    ))}
                  </Stack>
                </Input.Wrapper>
              </React.Fragment>
            );
          })}
          {canAdd && !hideButton && (
            <Button
              variant="light"
              leftIcon={<IconPlus size={18} />}
              onClick={handleOpenModal}
              {...buttonProps}
            >
              {buttonLabel}
            </Button>
          )}
          {hideButton && !_values.length && (
            <Text color="dimmed" size="sm">
              No resources selected
            </Text>
          )}
        </Stack>
      </Input.Wrapper>
    );
  }
);

ResourceSelectMultiple.displayName = 'ResourceSelectMultiple';

const InputResourceSelectMultiple = withController(ResourceSelectMultiple, ({ field }) => ({
  value: field.value,
}));
export default InputResourceSelectMultiple;
