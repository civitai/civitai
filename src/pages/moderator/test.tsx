import { CloseButton, Skeleton, Table, Text, useMantineTheme } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React, { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

import createSlots from '~/libs/slots/create-slots';
import { getRandomInt } from '~/utils/number-helpers';

import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { Page } from '~/components/AppLayout/Page';
import { IsClient } from '~/components/IsClient/IsClient';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { SourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { ImageCropperContent } from '~/components/Generation/Input/ImageCropModal';
import { trpc } from '~/utils/trpc';

const array = new Array(100).fill(0).map(() => getRandomInt(100, 400));

const { Slots, Slot } = createSlots(['header', 'footer']);

function Header({
  children,
  withCloseButton = true,
}: {
  children: React.ReactNode;
  withCloseButton?: boolean;
}) {
  return (
    <Slot name="header">
      <div className="flex items-center justify-between bg-red-400 p-2 text-white">
        <div>{children}</div>
        {withCloseButton && <CloseButton />}
      </div>
    </Slot>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <Slot name="footer">
      <div className="bg-green-400 p-2 text-white">{children}</div>
    </Slot>
  );
}

function ComponentWithSlots({ children }: { children: React.ReactNode }) {
  return (
    <Slots context={{ test: true }}>
      {(slots) => (
        <div className="container flex flex-col">
          {slots.header}
          <div className="bg-orange-400 text-white">{children}</div>
          {slots.footer}
        </div>
      )}
    </Slots>
  );
}

function Content() {
  return (
    <>
      <Header>This is my header</Header>
      This is my content
      <Footer>This is my Footer</Footer>
    </>
  );
}

const someObject = new Promise((resolve) =>
  resolve({
    test: true,
    array: [1, 2, 3, 4],
  })
);

const imageData = [
  {
    url: 'https://orchestration.civitai.com/v2/consumer/blobs/105199769287210187091817890725710212070',
    width: 2560,
    height: 3712,
  },
  {
    url: 'https://orchestration.civitai.com/v2/consumer/blobs/266732626383127446662542620709216983092',
    width: 1856,
    height: 1280,
  },
];

function Test() {
  const [count, setCount] = useState(0);

  const theme = useMantineTheme();

  // useEffect(() => {
  //   dialogStore.trigger({
  //     component: LoginModal,
  //   });
  // }, []);

  const [data, setData] = useState<{ url: string; width: number; height: number }[] | null>([
    {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/N6468H8QNQWH0NCJRB6C5XVSY0.jpeg',
      height: 1216,
      width: 832,
    },
    {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/CXJQSCS1TYZR1PX45C7QBVB8E0.jpeg',
      height: 1216,
      width: 832,
    },
    {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/CXHV148Y1K72MSDW3AJ6X32FZ0.jpeg',
      height: 1216,
      width: 832,
    },
    {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/1RWAZZVXPDYN4NPD8PM312WCT0.jpeg',
      height: 1216,
      width: 832,
    },
  ]);

  useEffect(() => {
    console.log({ data });
  }, [data]);

  return (
    <div className="container flex h-full max-w-sm flex-col gap-3">
      <SourceImageUploadMultiple
        value={data}
        onChange={setData}
        max={7}
        warnOnMissingAiMetadata
        // cropToFirstImage
      >
        {(previewItems) => (
          <div className="grid grid-cols-4 gap-4">
            {previewItems.map((item, i) => (
              <SourceImageUploadMultiple.Image key={i} index={i} {...item} />
            ))}
            <SourceImageUploadMultiple.Dropzone />
          </div>
        )}
      </SourceImageUploadMultiple>
    </div>
  );
}

const messages = [
  {
    content:
      'A black and white photograph shows the blurred silhouette of an alien , behind a frosted or translucent surface. The hand is sharply defined and pressed against the surface, creating a stark contrast with the rest of the hazy, indistinct figure. The background is a soft gradient of gray tones, enhancing the mysterious and artistic atmosphere, ',
  },
];

function ViewDuplicateHashLinks() {
  const [state, setState] = useState<Record<string, string[]> | null>();

  function handleLoad(files: FileList) {
    const reader = new FileReader();
    reader.onload = function (e) {
      if (!reader.result) return;
      const result = reader.result
        .toString()
        .split('\r\n')
        .reduce<Record<string, string[]>>((acc, value) => {
          const [hash, links] = value.replaceAll('"', '').split(',');

          if (!links?.startsWith('http')) return acc;

          if (!acc[hash]) acc[hash] = [];
          for (const link of links.split(';')) {
            acc[hash] = [...new Set([...acc[hash], link.trim()])];
          }

          return acc;
        }, {});
      setState(result);
    };
    reader.readAsText(files[0]);
  }

  return (
    <div className="container">
      <Link href="/moderator/test?test=true">Test link</Link>
      {!state ? (
        <input
          type="file"
          onChange={(e) => {
            if (e.target.files) handleLoad(e.target.files);
          }}
        ></input>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Hash</Table.Th>
              <Table.Th>Links</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Object.entries(state).map(([hash, values]) => (
              <Table.Tr key={hash}>
                <Table.Td>{hash}</Table.Td>
                <Table.Td>
                  <div className="flex flex-col">
                    {values.map((link, i) => (
                      <ModelVersionLink key={i} url={link} />
                    ))}
                  </div>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}

const useClickedStore = create<{
  clicked: Record<string, boolean>;
  setClicked: (value: string) => void;
}>()(
  persist(
    immer((set) => ({
      clicked: {},
      setClicked: (value) =>
        set((state) => {
          state.clicked[value] = true;
        }),
    })),
    { name: 'duplicate-hashes-clicked' }
  )
);

function ModelVersionLink({ url }: { url: string }) {
  const clicked = useClickedStore(useCallback((state) => state.clicked[url], [url]));
  const setClicked = useClickedStore((state) => state.setClicked);
  return (
    <Text
      component="a"
      variant="link"
      className="cursor-pointer"
      href={url}
      target="_blank"
      rel="noreferrer"
      color={clicked ? 'yellow' : undefined}
      onClick={() => setClicked(url)}
    >
      {url}
    </Text>
  );
}

import { Radio, RadioGroup } from '@headlessui/react';
import clsx from 'clsx';

const memoryOptions = [
  { name: '4 GB', inStock: true },
  { name: '8 GB', inStock: true },
  { name: '16 GB', inStock: true },
  { name: '32 GB', inStock: true },
  { name: '64 GB', inStock: true },
  { name: '128 GB', inStock: false },
];

function Example() {
  const [mem, setMem] = useState(memoryOptions[2]);

  return (
    <fieldset aria-label="Choose a memory option">
      <div className="flex items-center justify-between">
        <div className="text-sm/6 font-medium text-dark-9">RAM</div>
        {/* <a href="#" className="text-sm/6 font-medium text-blue-7 hover:text-blue-6">
          See performance specs
        </a> */}
      </div>

      <RadioGroup
        value={mem}
        onChange={setMem}
        className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-6"
      >
        {memoryOptions.map((option) => (
          <Radio
            key={option.name}
            value={option}
            disabled={!option.inStock}
            className={clsx(
              option.inStock
                ? 'cursor-pointer focus:outline-none'
                : 'cursor-not-allowed opacity-25',
              'flex items-center justify-center rounded-md  p-3 text-sm font-semibold uppercase ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
              'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
              'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
            )}
          >
            {option.name}
          </Radio>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

import { Label, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { ImagesAsPostsInfinite } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { KontextAd } from '~/components/Ads/Kontext/KontextAd';
import { SourceImageUploadMultiple } from '~/components/Generation/Input/SourceImageUploadMultiple';

const people = [
  {
    id: 1,
    name: 'Wade Cooper',
    avatar:
      'https://images.unsplash.com/photo-1491528323818-fdd1faba62cc?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 2,
    name: 'Arlene Mccoy',
    avatar:
      'https://images.unsplash.com/photo-1550525811-e5869dd03032?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 3,
    name: 'Devon Webb',
    avatar:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2.25&w=256&h=256&q=80',
  },
  {
    id: 4,
    name: 'Tom Cook',
    avatar:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 5,
    name: 'Tanya Fox',
    avatar:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 6,
    name: 'Hellen Schmidt',
    avatar:
      'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 7,
    name: 'Caroline Schultz',
    avatar:
      'https://images.unsplash.com/photo-1568409938619-12e139227838?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 8,
    name: 'Mason Heaney',
    avatar:
      'https://images.unsplash.com/photo-1531427186611-ecfd6d936c79?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 9,
    name: 'Claudie Smitham',
    avatar:
      'https://images.unsplash.com/photo-1584486520270-19eca1efcce5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 10,
    name: 'Emil Schaefer',
    avatar:
      'https://images.unsplash.com/photo-1561505457-3bcad021f8ee?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

function ExampleSelect() {
  const [selected, setSelected] = useState(people[3]);

  return (
    <Listbox value={selected} onChange={setSelected}>
      <div className="relative mt-2">
        <ListboxButton
          className={clsx(
            'grid w-full cursor-default grid-cols-1 rounded-md py-1.5 pl-3 pr-2 text-left outline outline-1 -outline-offset-1 focus:outline focus:outline-2 focus:-outline-offset-2  sm:text-sm/6',
            'bg-white text-dark-9 outline-gray-4 focus:outline-blue-5',
            'dark:bg-dark-6 dark:text-dark-0 dark:outline-dark-4 dark:focus:outline-blue-8'
          )}
        >
          <span className="col-start-1 row-start-1 flex items-center gap-3 pr-6">
            {/* <img alt="" src={selected.avatar} className="size-5 shrink-0 rounded-full" /> */}
            <span className="block truncate">{selected.name}</span>
          </span>
          <IconSelector
            aria-hidden="true"
            className={clsx(
              'col-start-1 row-start-1 size-5 self-center justify-self-end sm:size-4',
              'text-gray-6'
            )}
          />
        </ListboxButton>

        <ListboxOptions
          transition
          anchor="bottom start"
          portal
          className={clsx(
            'z-10 mt-1 max-h-56 w-[var(--button-width)]  overflow-auto rounded-md py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none data-[closed]:data-[leave]:opacity-0 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in sm:text-sm',
            'bg-white',
            'dark:bg-dark-6'
          )}
        >
          {people.map((person) => (
            <ListboxOption
              key={person.id}
              value={person}
              className={clsx(
                'group relative cursor-default select-none py-2 pl-3 pr-9 data-[focus]:outline-none',
                'text-dark-9 data-[focus]:bg-blue-5 data-[focus]:text-white',
                'dark:text-dark-0 dark:data-[focus]:bg-blue-8 '
              )}
            >
              <div className="flex items-center">
                {/* <img alt="" src={person.avatar} className="size-5 shrink-0 rounded-full" /> */}
                <span className="ml-3 block truncate font-normal group-data-[selected]:font-semibold">
                  {person.name}
                </span>
              </div>

              <span
                className={clsx(
                  'absolute inset-y-0 right-0 flex items-center pr-4 group-[&:not([data-selected])]:hidden ',
                  'text-blue-5 group-data-[focus]:text-white',
                  'dark:text-blue-8'
                )}
              >
                <IconCheck aria-hidden="true" className="size-5" />
              </span>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

function ExamplePopover() {
  return (
    <div className="flex w-full justify-center pt-20">
      <div className="flex gap-8">
        <div className="text-sm/6 font-semibold text-white/50">Products</div>
        <Popover>
          <PopoverButton className="block text-sm/6 font-semibold text-white/50 focus:outline-none data-[active]:text-white data-[hover]:text-white data-[focus]:outline-1 data-[focus]:outline-white">
            Solutions
          </PopoverButton>
          <PopoverPanel
            transition
            anchor="bottom"
            className="divide-y divide-white/5 rounded-xl bg-white/5 text-sm/6 transition duration-200 ease-in-out [--anchor-gap:var(--spacing-5)] data-[closed]:-translate-y-1 data-[closed]:opacity-0"
          >
            <div className="p-3">
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Insights</p>
                <p className="text-white/50">Measure actions your users take</p>
              </a>
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Automations</p>
                <p className="text-white/50">Create your own targeted content</p>
              </a>
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Reports</p>
                <p className="text-white/50">Keep track of your growth</p>
              </a>
            </div>
            <div className="p-3">
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Documentation</p>
                <p className="text-white/50">Start integrating products and tools</p>
              </a>
            </div>
          </PopoverPanel>
        </Popover>
        <div className="text-sm/6 font-semibold text-white/50">Pricing</div>
      </div>
    </div>
  );
}

export default Test;
// export default Page(Test, { getLayout: (page) => <main className="size-full">{page}</main> });
