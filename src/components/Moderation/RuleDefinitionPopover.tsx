import { Button, ButtonProps, Center, JsonInput, Loader, Popover, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { trpc } from '~/utils/trpc';

export function RuleDefinitionPopover({ ruleId, entityType, ...buttonProps }: Props) {
  const [opened, { toggle }] = useDisclosure();

  const { data, isLoading } = trpc.moderator.rules.getById.useQuery(
    { id: ruleId, entityType },
    { enabled: opened }
  );

  return (
    <Popover width={400} opened={opened} onChange={toggle} withArrow withinPortal>
      <Popover.Target>
        <Button size="xs" variant="outline" onClick={toggle} {...buttonProps}>
          View rule definition
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Center>
          {isLoading ? (
            <Loader />
          ) : data ? (
            <JsonInput
              value={JSON.stringify(data.definition, null, 2)}
              w="100%"
              minRows={10}
              readOnly
            />
          ) : (
            <Text>Rule not found</Text>
          )}
        </Center>
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & { ruleId: number; entityType: 'Model' | 'Image' };
