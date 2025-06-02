import { Button, SegmentedControl, Tabs, Text, Title } from '@mantine/core';
import { forwardRef, useRef, useState } from 'react';
import { z } from 'zod';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwLoader } from '~/components/TwLoader/TwLoader';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { BlocklistType } from '~/server/common/enums';
import type { BlocklistDTO } from '~/server/services/blocklist.service';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import clsx from 'clsx';
import { Page } from '~/components/AppLayout/Page';

const schema = z.object({
  blocklist: z.string(),
});

function BlocklistsPage() {
  const tabs = Object.values(BlocklistType).sort();
  const [tab, setTab] = useState(tabs[0]);
  const [state, setState] = useState<string>('add');
  const stateRef = useRef<string>(state);

  const { data, isLoading } = trpc.blocklist.getBlocklist.useQuery({ type: tab });

  const form = useForm({ schema });

  function handleStateChange(value: string) {
    setState(value);
    stateRef.current = value;
    form.reset();
  }

  function addItemToRemove(value: string) {
    if (stateRef.current === 'add') return;
    const currentValue =
      form
        .getValues()
        .blocklist?.split(',')
        .filter((x) => x.length > 0) ?? [];
    form.setValue('blocklist', [...currentValue, value].join(','));
  }

  return (
    <div className="container flex max-w-sm flex-col gap-3">
      <Title>Blocklists</Title>
      <Tabs variant="pills" value={tab} onTabChange={(value) => setTab(value as BlocklistType)}>
        <Tabs.List>
          {tabs.map((tab) => (
            <Tabs.Tab key={tab} value={tab}>
              {splitUppercase(tab)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      {isLoading ? (
        <div className="flex items-center justify-center p-5">
          <TwLoader />
        </div>
      ) : (
        <>
          <TwCard className="gap-2 border p-3">
            {!!data?.id && (
              <SegmentedControl
                value={state}
                onChange={handleStateChange}
                data={[
                  { label: 'Add', value: 'add' },
                  { label: 'Remove', value: 'remove' },
                ]}
              />
            )}

            <AddOrRemoveItems tab={tab} data={data} state={state} form={form} />
          </TwCard>
          {!data?.data.length ? (
            <Text>No items found for this blocklist</Text>
          ) : (
            <div className="flex flex-col gap-2">
              <Text>{splitUppercase(tab)}</Text>
              <div className="flex flex-wrap gap-2">
                {data.data.sort().map((item) => {
                  return (
                    <span
                      key={item}
                      className={clsx(
                        'inline-flex  items-center rounded-md bg-gray-1 px-3 py-1 text-xs font-medium text-gray-6 ring-1 ring-inset ring-gray-5/10 dark:bg-dark-6 dark:text-dark-1 dark:ring-dark-3/10',
                        { ['cursor-pointer']: state === 'remove' }
                      )}
                      onClick={() => addItemToRemove(item)}
                    >
                      {item}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const AddOrRemoveItems = forwardRef<
  HTMLTextAreaElement,
  { tab: BlocklistType; data?: BlocklistDTO; state: string; form: any }
>(({ tab, data, state, form }, ref) => {
  const queryUtils = trpc.useUtils();

  const upsert = trpc.blocklist.upsertBlocklist.useMutation({
    onSuccess: () => {
      queryUtils.blocklist.getBlocklist.invalidate({ type: tab });
      form.reset();
    },
  });
  const remove = trpc.blocklist.removeItems.useMutation({
    onSuccess: () => {
      queryUtils.blocklist.getBlocklist.invalidate({ type: tab });
      form.reset();
    },
  });

  function handleSubmit({ blocklist }: z.infer<typeof schema>) {
    const items = blocklist
      .split(',')
      .map((item) => item.trim())
      .filter((x) => x.length > 0);
    if (state === 'add') upsert.mutate({ id: data?.id, type: tab, blocklist: items });
    else if (state === 'remove' && !!data?.id) remove.mutate({ id: data.id, items: items });
  }

  return (
    <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-2">
      <InputTextArea
        ref={ref}
        name="blocklist"
        placeholder={`${
          state === 'add' ? 'Add comma delimited items to' : 'Remove comma delimited items from'
        } blocklist`}
      />
      <div className="flex justify-end">
        <Button type="submit" loading={upsert.isLoading || remove.isLoading}>
          Submit
        </Button>
      </div>
    </Form>
  );
});

AddOrRemoveItems.displayName = 'AddOrRemoveItems';

export default Page(BlocklistsPage, { features: (features) => features.blocklists });
