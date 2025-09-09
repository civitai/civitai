import { trpc } from '~/utils/trpc';
import { useLayoutEffect, useRef, useState } from 'react';
import { DatePickerInput } from '@mantine/dates';
import { Select, Loader, Table, Text } from '@mantine/core';
import { NoContent } from '~/components/NoContent/NoContent';
import { NextLink } from '~/components/NextLink/NextLink';
import type { Flagged } from '~/server/http/orchestrator/flagged-consumers';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useVirtualizer } from '@tanstack/react-virtual';

export default function OrchestratorFlaggedConsumersList() {
  const [reason, setReason] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return date;
  });
  const { data } = trpc.orchestrator.getFlaggedReasons.useQuery({ startDate });
  const _reason = reason ?? data?.[0].reason;

  return (
    <div className="container max-w-sm">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h1 className="text-2xl font-bold">Orchestrator Flagged Consumers</h1>
        <div className="flex gap-1">
          <DatePickerInput
            label="Start Date"
            value={startDate}
            onChange={(value) => (value ? setStartDate(value) : undefined)}
            maxDate={new Date()}
          />
          <Select
            label="Reason"
            value={_reason}
            data={data?.map((x) => x.reason)}
            onChange={(value) => setReason(value)}
          />
        </div>
      </div>
      {_reason && <FlaggedConsumersList reason={_reason} startDate={startDate} />}
    </div>
  );
}

function FlaggedConsumersList({ startDate, reason }: { startDate: Date; reason: string }) {
  // const [status, setStatus] = useState<string>()
  // const _status = status ?? data[0].status;
  // const strikes = data.find(x => x.status === _status);
  const { data, isLoading } = trpc.orchestrator.getFlaggedConsumers.useQuery({ startDate, reason });

  if (isLoading) return <Loader className="mx-auto" />;
  if (!data?.length) return <NoContent />;

  return <VirtualList data={data} />;
}

function VirtualList({ data }: { data: Flagged[] }) {
  const ref = useRef<HTMLTableSectionElement | null>(null);
  const scrollAreaRef = useScrollAreaRef();

  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (ref.current && scrollAreaRef?.current) {
      setScrollMargin(getOffsetTopRelativeToAncestor(ref.current, scrollAreaRef.current));
    }
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: (i) => 40,
    overscan: 5,
    getItemKey: (i) => data[i].consumerId,
    scrollMargin,
    initialOffset: () => scrollAreaRef?.current?.scrollTop ?? 0,
  });

  return (
    <Table stickyHeader striped className="table-fixed">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Consumer Id</Table.Th>
          <Table.Th>Unreviewed Strikes</Table.Th>
          <Table.Th>Total Strikes</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody
        ref={ref}
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((item) => (
          <VirtualItem
            key={item.key.toString()}
            item={data[item.index]}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: 40,
              transform: `translateY(${item.start - rowVirtualizer.options.scrollMargin}px)`,
            }}
          />
        ))}
      </Table.Tbody>
    </Table>
  );
}

function VirtualItem({ style, item }: { style?: React.CSSProperties; item: Flagged }) {
  return (
    <Table.Tr style={style} className="flex">
      <Table.Td className="flex-1">
        <NextLink href={`flagged/${item.consumerId}`}>
          <Text color="blue" component="span">
            {item.consumerId}
          </Text>
        </NextLink>
      </Table.Td>
      <Table.Td className="flex-1">
        <span>{item.unreviewedStrikes}</span>
      </Table.Td>
      <Table.Td className="flex-1">
        <span>{item.totalStrikes}</span>
      </Table.Td>
    </Table.Tr>
  );
}

function getOffsetTopRelativeToAncestor(descendant: HTMLElement, ancestor: HTMLElement): number {
  let offset = 0;
  let current: HTMLElement | null = descendant;

  while (current && current !== ancestor) {
    offset += current.offsetTop;
    current = current.offsetParent as HTMLElement;
  }

  if (current !== ancestor) {
    throw new Error('Ancestor is not an offsetParent of the descendant');
  }

  return offset;
}
