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

  return (
    <IsClient>
      <div className="container flex items-center gap-2 pb-2">
        <span>{count}</span>
        <Button onClick={() => setCount((c) => c + 1)}>Counter</Button>
      </div>
      <ComponentWithSlots>
        <Content />
      </ComponentWithSlots>
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
