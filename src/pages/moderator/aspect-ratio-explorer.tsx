import { ActionIcon, Button, NumberInput, TextInput } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { AspectRatio, AspectRatioMap } from '~/libs/generation/utils/AspectRatio';

export default function AspectRatioExplorer() {
  const [value, setValue] = useState('');
  const [aspectRatios, setAspectRatios] = useLocalStorage({
    key: 'aspect-ratio-explorer',
    defaultValue: ['16:9', '3:2', '1:1'],
  });
  const [multiplier, setMultiplier] = useState<number | undefined>(64);
  const [resolution, setResolution] = useState<number | undefined>(1024);

  function addAspectRatio() {
    const parsed = AspectRatio.parse(value);
    if (parsed) setAspectRatios((state) => [...state, parsed]);
  }

  function removeAspectRatio(value: string) {
    setAspectRatios((state) => state.filter((x) => x !== value));
  }

  const aspectRatioList = useMemo(() => {
    if (!aspectRatios.length || !multiplier) return [];
    return Object.entries(AspectRatioMap(aspectRatios, { multiplier }))
      .map(([key, aspectRatio]) => ({ key, ...aspectRatio }))
      .sort((a, b) => b.ratio - a.ratio);
  }, [aspectRatios, multiplier]);

  return (
    <div className="container flex max-w-sm flex-col gap-3">
      <div className="flex items-end gap-3">
        <TextInput
          label="Aspect Ratio"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <Button onClick={addAspectRatio}>Add</Button>
      </div>
      <div className="flex gap-3">
        <NumberInput label="Multiplier" value={multiplier} onChange={setMultiplier} />
        <NumberInput label="Resolution" value={resolution} onChange={setResolution} />
      </div>

      {!!aspectRatioList.length && resolution && (
        <ul>
          {aspectRatioList.map((aspectRatio) => {
            const key = aspectRatio.key;
            try {
              const { width, height } = aspectRatio.getSize(resolution);
              return (
                <li key={key} className="flex items-center justify-between">
                  <span>
                    {key} - {width}:{height}
                  </span>
                  <ActionIcon color="red" onClick={() => removeAspectRatio(key)}>
                    <IconX />
                  </ActionIcon>
                </li>
              );
            } catch (e: any) {
              return (
                <li key={key} className="flex items-center justify-between">
                  <span>
                    {key} - {e.message}
                  </span>
                  <ActionIcon color="red" onClick={() => removeAspectRatio(key)}>
                    <IconX />
                  </ActionIcon>
                </li>
              );
            }
          })}
        </ul>
      )}
    </div>
  );
}
