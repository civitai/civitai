import { Box, Button, Table, Text, useMantineTheme } from '@mantine/core';
import React, {
  Key,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { TypeOf, ZodAny, ZodArray, ZodEffects, ZodObject, ZodString, ZodTypeAny, z } from 'zod';
import { StoreApi, create, createStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Announcement } from '~/components/Announcements/Announcement';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { getRandomInt } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const array = new Array(100).fill(0).map(() => getRandomInt(100, 400));
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

export default function Test() {
  const [state, setState] = useState<Record<string, string[]> | null>();

  function handleLoad(files: FileList) {
    const reader = new FileReader();
    reader.onload = function (e) {
      if (!reader.result) return;
      const result = reader.result
        .toString()
        .split('\r\n')
        .reduce<Record<string, string[]>>((acc, value) => {
          const [hash, link] = value.replaceAll('"', '').split(',');
          if (!link?.startsWith('http')) return acc;

          if (!acc[hash]) acc[hash] = [];
          acc[hash] = [...new Set([...acc[hash], link])];
          return acc;
        }, {});
      setState(result);
    };
    reader.readAsText(files[0]);
  }

  return (
    <div className="container">
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
