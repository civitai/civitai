import { Button, ButtonProps, Divider, Input, InputWrapperProps, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef, useEffect, useMemo } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/dialog-registry';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { withController } from '~/libs/form/hoc/withController';
import { getDisplayName } from '~/utils/string-helpers';
import { ResourceSelectOptions, ResourceSelectSource } from './resource-select.types';
import { GenerationResource } from '~/server/services/generation/generation.service';

export type ResourceSelectMultipleProps = {
  limit?: number;
  value?: GenerationResource[];
  onChange?: (value?: GenerationResource[]) => void;
  buttonLabel: React.ReactNode;
  modalTitle?: React.ReactNode;
  buttonProps?: Omit<ButtonProps, 'onClick'>;
  options?: ResourceSelectOptions;
  modalOpened?: boolean;
  onCloseModal?: () => void;
  hideButton?: boolean;
  selectSource?: ResourceSelectSource;
} & Omit<InputWrapperProps, 'children' | 'onChange'>;

export const ResourceSelectMultiple = forwardRef<HTMLDivElement, ResourceSelectMultipleProps>(
  (
    {
      limit,
      value = [],
      onChange,
      buttonLabel,
      modalTitle,
      buttonProps,
      options = {},
      modalOpened,
      onCloseModal,
      hideButton = false,
      selectSource = 'generation',
      ...inputWrapperProps
    },
    ref
  ) => {
    // const { types } = options;
    const types = options.resources?.map((x) => x.type);
    const baseModels = [
      ...new Set(
        options.resources?.flatMap((x) => [...(x.baseModels ?? []), ...(x.partialSupport ?? [])]) ??
          []
      ),
    ];

    // _types used to set up groups
    const _types = [...new Set(types ?? value?.map((x) => x.model.type) ?? [])];
    const _values = useMemo(
      () =>
        types
          ? [...value].filter(
              (x) =>
                types.includes(x.model.type) &&
                (!!baseModels?.length ? baseModels.includes(x.baseModel) : true)
            )
          : value,
      [value]
    );
    const groups = _types
      .map((type) => ({
        type,
        label: getDisplayName(type),
        resources: _values.filter((x) => x.model.type === type),
      }))
      .filter((x) => !!x.resources.length);
    const canAdd = !limit || _values.length < limit;

    const handleAdd = (resource: GenerationResource) => {
      if (!canAdd) return;
      if (
        selectSource === 'generation' &&
        resource &&
        !resource.canGenerate &&
        resource.substitute?.canGenerate
      ) {
        onChange?.([..._values, { ...resource, ...resource.substitute }]);
      } else {
        onChange?.([..._values, resource]);
      }
      onCloseModal?.();
    };

    const handleRemove = (id: number) => {
      const filtered = [..._values.filter((x) => x.id !== id)];
      // const emitValue = !!filtered.length ? filtered : undefined;
      onChange?.(filtered);
    };

    const handleUpdate = (resource: GenerationResource) => {
      const index = _values.findIndex((x) => x.id === resource.id);
      if (index > -1) {
        const emitValue = [..._values];
        emitValue[index] = resource;
        onChange?.(emitValue);
      }
    };

    // removes resources that have unsupported types
    useEffect(() => {
      if (_values.length !== value.length) onChange?.(_values.length ? _values : []);
    }, [value, _values]); //eslint-disable-line

    const handleOpenModal = () => {
      openResourceSelectModal({
        title: modalTitle ?? buttonLabel,
        onSelect: handleAdd,
        options,
        onClose: onCloseModal,
        selectSource,
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

    console.log(sortedGroups);

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
                        selectSource={selectSource}
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
