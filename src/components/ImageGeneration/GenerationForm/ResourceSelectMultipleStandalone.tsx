import { Accordion, Button, Text, Anchor, Badge } from '@mantine/core';
import type { ResourceSelectMultipleProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { ResourceSelectMultiple } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import {
  ResourceSelectHandler,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconPlus } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import classes from './ResourceSelectMultipleStandalone.module.scss';
import { useEffect, useMemo, useRef } from 'react';

export function ResourceSelectMultipleStandalone({
  value = [],
  onChange,
  ...props
}: ResourceSelectMultipleProps) {
  const status = useGenerationStatus();
  const resources = value;
  const currentUser = useCurrentUser();
  const resourceIds = !!value?.length ? value.map((x) => x.id) : [];
  const atLimit = resourceIds.length >= status.limits.resources;
  // const [opened, setOpened] = useState(false);

  const options = {
    ...props.options,
    excludeIds: resourceIds,
  };

  const resourceSelectHandler = ResourceSelectHandler(options);

  const stringDependency =
    JSON.stringify(resourceSelectHandler.types) + JSON.stringify(resourceSelectHandler.baseModels);
  const _values = useMemo(
    () => resourceSelectHandler.getValues(value) ?? [],
    [value, stringDependency]
  );
  const valuesRef = useRef(_values);
  valuesRef.current = _values;
  useEffect(() => {
    if (_values.length > 0 && !value?.every((v) => _values.some((x) => x.id === v.id)))
      onChange?.(_values.length ? _values : null);
    else {
      setTimeout(() => {
        const updated = valuesRef.current;
        if (updated.length !== value?.length) onChange?.(updated.length ? updated : null);
      }, 0);
    }
  }, [_values]);

  return (
    <PersistentAccordion
      storeKey="generation-form-resources"
      classNames={{
        item: classes.accordionItem,
        control: classes.accordionControl,
        content: classes.accordionContent,
      }}
      transitionDuration={0}
    >
      <Accordion.Item value="resources" className="border-b-0">
        <Accordion.Control>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Text size="sm" fw={590}>
                Additional Resources
              </Text>
              {!!resources?.length && (
                <Badge className="font-semibold">
                  {resources.length}/{status.limits.resources}
                </Badge>
              )}

              <Button
                component="span"
                size="compact-sm"
                variant="light"
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  resourceSelectHandler
                    .select({
                      title: props.buttonLabel,
                      selectSource: props.selectSource,
                      excludedIds: resources?.map((x) => x.id),
                    })
                    .then((resource) => {
                      if (!resource) return;
                      onChange?.(resourceSelectHandler.getValues([...(resources ?? []), resource]));
                    });
                }}
                radius="xl"
                ml="auto"
                disabled={atLimit}
                classNames={{ inner: 'flex gap-1' }}
              >
                <IconPlus size={16} />
                <Text size="sm" fw={500}>
                  Add
                </Text>
              </Button>
            </div>

            {atLimit && (!currentUser || currentUser.tier === 'free') && (
              <Text size="xs">
                <Link legacyBehavior href="/pricing" passHref>
                  <Anchor
                    color="yellow"
                    rel="nofollow"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  >
                    Become a member
                  </Anchor>
                </Link>{' '}
                <Text inherit span>
                  to use more resources at once
                </Text>
              </Text>
            )}
          </div>
        </Accordion.Control>
        <Accordion.Panel classNames={{ content: 'p-0' }}>
          <ResourceSelectMultiple
            {...props}
            value={value}
            onChange={onChange}
            // modalOpened={opened}
            // onCloseModal={() => setOpened(false)}
            options={options}
            hideButton
          />
        </Accordion.Panel>
      </Accordion.Item>
    </PersistentAccordion>
  );
}

export const InputResourceSelectMultipleStandalone = withController(
  ResourceSelectMultipleStandalone,
  ({ field }) => ({
    value: field.value,
  })
);
