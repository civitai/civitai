import { Button, Checkbox, Group, ScrollArea, Stack, Text, createStyles } from '@mantine/core';
import { IconLock, IconPlus, IconWorld } from '@tabler/icons-react';
import { z } from 'zod';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Form, InputCheckboxGroup, useForm } from '~/libs/form';

// TODO.collection: move to collection.schema.ts
const schema = z.object({
  collectionIds: z.array(z.coerce.number()).min(1, 'Please select at least one collection'),
  resourceId: z.number(),
});

// TODO.collection: fetch actual data
const mockCollections = [
  { id: 1, name: 'Collection 1 Collection 1 Collection 1 Collection 1', read: 'public' },
  { id: 2, name: 'Collection 2', read: 'public' },
  { id: 3, name: 'Collection 3', read: 'private' },
  { id: 4, name: 'Collection 4', read: 'public' },
  { id: 5, name: 'Collection 5', read: 'public' },
];

const useStyles = createStyles(() => ({
  body: { alignItems: 'center' },
  labelWrapper: { flex: 1 },
}));

const { openModal: openAddToCollectionModal, Modal } = createContextModal<{ resourceId: number }>({
  name: 'addToCollection',
  title: 'Add to Collection',
  size: 'sm',
  Element: ({ context, props }) => {
    const { resourceId } = props;
    const { classes } = useStyles();
    const form = useForm({
      schema,
      defaultValues: { resourceId, collectionIds: [] },
      shouldUnregister: false,
    });

    const handleSubmit = (data: z.infer<typeof schema>) => {
      // TODO.collection: send data to server
      console.log(data);
      context.close();
    };

    return (
      <Form form={form} onSubmit={handleSubmit}>
        <Stack spacing="xl">
          <Stack spacing={4}>
            <Group spacing="xs" position="apart" noWrap>
              <Text size="sm" weight="bold">
                Your collections
              </Text>
              <Button variant="subtle" size="xs" leftIcon={<IconPlus size={16} />} compact>
                New collection
              </Button>
            </Group>
            <ScrollArea.Autosize maxHeight={200}>
              <InputCheckboxGroup name="collectionIds" orientation="vertical" spacing={8}>
                {mockCollections.map((collection) => (
                  <Checkbox
                    key={collection.id}
                    classNames={classes}
                    value={collection.id.toString()}
                    label={
                      <Group spacing="xs" position="apart" w="100%" noWrap>
                        <Text lineClamp={1} inherit>
                          {collection.name}
                        </Text>
                        {collection.read === 'private' ? (
                          <IconLock size={18} />
                        ) : (
                          <IconWorld size={18} />
                        )}
                      </Group>
                    }
                  />
                ))}
              </InputCheckboxGroup>
            </ScrollArea.Autosize>
          </Stack>
          <Group position="right">
            <Button type="submit">Add</Button>
          </Group>
        </Stack>
      </Form>
    );
  },
});

export { openAddToCollectionModal };
export default Modal;
