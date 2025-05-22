import { Accordion, Button, Text, Anchor, Badge, createStyles } from '@mantine/core';
import {
  ResourceSelectMultiple,
  ResourceSelectMultipleProps,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import {
  ResourceSelectHandler,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconPlus } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ResourceSelectMultipleStandalone(props: ResourceSelectMultipleProps) {
  const status = useGenerationStatus();
  const resources = props.value;
  const currentUser = useCurrentUser();
  const resourceIds = !!props.value?.length ? props.value.map((x) => x.id) : [];
  const atLimit = resourceIds.length >= status.limits.resources;
  const { classes } = useStyles();
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
              <Text size="sm" weight={590}>
                Additional Resources
              </Text>
              {!!resources?.length && (
                <Badge className="font-semibold">
                  {resources.length}/{status.limits.resources}
                </Badge>
              )}

              <Button
                component="span"
                compact
                variant="light"
                onClick={(e) => {
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
                <Text size="sm" weight={500}>
                  Add
                </Text>
              </Button>
            </div>

            {atLimit && (!currentUser || currentUser.tier === 'free') && (
              <Text size="xs">
                <Link legacyBehavior href="/pricing" passHref>
                  <Anchor color="yellow" rel="nofollow" onClick={(e) => e.stopPropagation()}>
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
        <Accordion.Panel>
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

const useStyles = createStyles((theme) => ({
  accordionItem: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff',

    '&:first-of-type': {
      borderTopLeftRadius: theme.radius.sm,
      borderTopRightRadius: theme.radius.sm,
    },

    '&:last-of-type': {
      borderBottomLeftRadius: theme.radius.sm,
      borderBottomRightRadius: theme.radius.sm,
    },

    '&[data-active]': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : `#fff`,
    },
  },
  accordionControl: {
    padding: '8px 8px 8px 12px',

    '&:hover': {
      background: 'transparent',
    },

    '&[data-active]': {
      borderRadius: '0 !important',
      borderBottom: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
      }`,
    },
  },
  accordionContent: {
    padding: '8px 12px 12px 12px',
  },
}));
