import type { ButtonProps, InputWrapperProps } from '@mantine/core';
import { Button, Divider, Input, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef, useEffect, useMemo, useRef } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/dialog-registry';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { withController } from '~/libs/form/hoc/withController';
import { getDisplayName } from '~/utils/string-helpers';
import type { ResourceSelectOptions, ResourceSelectSource } from './resource-select.types';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { ResourceSelectHandler } from '~/components/ImageGeneration/GenerationForm/generation.utils';

export type ResourceSelectMultipleProps = {
  limit?: number;
  value?: GenerationResource[] | null;
  onChange?: (value: GenerationResource[] | null) => void;
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
    const { types, baseModels, select, getValues } = ResourceSelectHandler(options);
    const stringDependency = JSON.stringify(types) + JSON.stringify(baseModels);

    // _types used to set up groups
    const _types = [...new Set(!!types.length ? types : value?.map((x) => x.model.type))];
    const _values = useMemo(() => getValues(value) ?? [], [value, stringDependency]);
    const valuesRef = useRef(_values);
    valuesRef.current = _values;
    const groups = _types
      .map((type) => ({
        type,
        label: getDisplayName(type),
        resources: _values.filter((x) => x.model.type === type),
      }))
      .filter((x) => !!x.resources.length);
    const canAdd = !limit || _values.length < limit;

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
      if (_values.length > 0 && _values.length !== value?.length)
        onChange?.(_values.length ? _values : null);
      else {
        setTimeout(() => {
          const updated = valuesRef.current;
          if (updated.length !== value?.length) onChange?.(updated.length ? updated : null);
        }, 0);
      }
    }, [_values, stringDependency]); //eslint-disable-line

    const handleOpenModal = () => {
      select({
        title: modalTitle ?? buttonLabel,
        selectSource,
        excludedIds: _values.map((x) => x.id),
      }).then((resource) => {
        if (!resource) return;
        onChange?.([..._values, resource]);
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
