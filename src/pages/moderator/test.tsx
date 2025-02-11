import { Box, Button, CloseButton, Table, Text, useMantineTheme } from '@mantine/core';
import { useLocalStorage, useSessionStorage } from '@mantine/hooks';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React, {
  FC,
  Key,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TypeOf, ZodAny, ZodArray, ZodEffects, ZodObject, ZodString, ZodTypeAny, z } from 'zod';
import { StoreApi, create, createStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Announcement } from '~/components/Announcements/Announcement';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import createSlots from '~/libs/slots/create-slots';
import { getRandomInt } from '~/utils/number-helpers';
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

export default function Test() {
  const [count, setCount] = useState(0);

  // // useEffect(() => {
  // //   throw new Error('custom error for testing');
  // // }, []);

  const theme = useMantineTheme();

  return (
    <IsClient>
      {/* <div className="container flex items-center gap-2 pb-2">
        <span>{count}</span>
        <Button
          onClick={() => {
            setCount((c) => c + 1);
          }}
        >
          Counter
        </Button>
      </div>
      <ComponentWithSlots>
        <Content />
      </ComponentWithSlots> */}
      <div className="container flex max-w-sm flex-col gap-3">
        <Example />
        <ExampleSelect />
      </div>
    </IsClient>
  );
}

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
          <thead>
            <tr>
              <th>Hash</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(state).map(([hash, values]) => (
              <tr key={hash}>
                <td>{hash}</td>
                <td>
                  <div className="flex flex-col">
                    {values.map((link, i) => (
                      <ModelVersionLink key={i} url={link} />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
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
