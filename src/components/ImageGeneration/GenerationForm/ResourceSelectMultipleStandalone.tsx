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

export function ResourceSelectMultipleStandalone(props: ResourceSelectMultipleProps) {
  const status = useGenerationStatus();
  const resources = props.value;
  const currentUser = useCurrentUser();
  const resourceIds = !!props.value?.length ? props.value.map((x) => x.id) : [];
  const atLimit = resourceIds.length >= status.limits.resources;
  // const [opened, setOpened] = useState(false);

  const options = {
    ...props.options,
    excludeIds: resourceIds,
  };

  const resourceSelectHandler = ResourceSelectHandler(options);

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
                      props.onChange?.(
                        resourceSelectHandler.getValues([...(resources ?? []), resource])
                      );
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
