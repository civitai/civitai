import type { TransactionInfo } from '@civitai/client';
import { ActionIcon, Card, Popover, Text, Tooltip } from '@mantine/core';
import { IconBolt, IconProgressBolt } from '@tabler/icons-react';
import { capitalize } from '~/utils/string-helpers';

export function TransactionsPopover({ data }: { data: TransactionInfo[] }) {
  return (
    <Popover>
      <Popover.Target>
        <Tooltip label="Buzz Transactions" withinPortal>
          <ActionIcon variant="subtle" color="yellow" size="sm">
            <IconProgressBolt />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Card p={0} className="w-48">
          <Card.Section withBorder>
            <Text className="px-3 py-1">Buzz Transactions</Text>
          </Card.Section>
          <Card.Section className="flex flex-col gap-1 px-3 py-1">
            {data.map((transaction, i) => {
              const color = transaction.accountType === 'user' ? 'yellow' : 'blue';
              return (
                <div key={i} className="flex items-center justify-between ">
                  <Text color={color} className="font-semibold">
                    {capitalize(color)}
                  </Text>
                  <Text
                    color={transaction.type === 'debit' ? 'red' : 'green'}
                    className="flex items-center gap-1"
                  >
                    <IconBolt size={16} fill="currentColor" />
                    <span>{transaction.amount.toLocaleString()}</span>
                  </Text>
                </div>
              );
            })}
          </Card.Section>
        </Card>
      </Popover.Dropdown>
    </Popover>
  );
}
