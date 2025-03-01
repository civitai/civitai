import {
  Input,
  InputWrapperProps,
  CloseButton,
  Card,
  Text,
  Switch,
  Collapse,
  Alert,
} from '@mantine/core';
import { getImageData } from '~/utils/media-preprocessors';
import { trpc } from '~/utils/trpc';
import { useEffect, useMemo, useState } from 'react';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import {
  maxOrchestratorImageFileSize,
  isOrchestratorUrl,
  maxUpscaleSize,
} from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import { getBase64 } from '~/utils/file-utils';
import { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { useLocalStorage } from '@mantine/hooks';
import { Radio, RadioGroup } from '@headlessui/react';
import clsx from 'clsx';
import { resizeImage } from '~/utils/image-utils';

function SourceImageUpload({
  value,
  onChange,
  upscale,
  removable = true,
  ...inputWrapperProps
}: {
  value?: SourceImageProps | null;
  onChange?: (value?: SourceImageProps | null) => void;
  upscale?: boolean;
  removable?: boolean;
} & Omit<InputWrapperProps, 'children' | 'value' | 'onChange'>) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { mutate, isLoading, isError } = trpc.orchestrator.imageUpload.useMutation({
    onSettled: () => {
      setLoading(false);
    },
    onError: (error) => {
      setError(error.message);
      setLoading(false);
    },
    onSuccess: ({ blob }) => {
      if (blob.url) handleUrlChange(blob.url);
      setLoading(false);
    },
  });

  function handleUrlChange(url: string) {
    getImageData(url).then(({ width, height }) => {
      setError(undefined);
      onChange?.({ url, width, height });
    });
  }

  function handleChange(value?: string) {
    setError(undefined);
    if (!value) onChange?.(null);
    else mutate({ sourceImage: value });
  }

  async function handleResizeToBase64(src: File | Blob | string) {
    setLoading(true);
    const resized = await resizeImage(src, {
      maxHeight: maxUpscaleSize,
      maxWidth: maxUpscaleSize,
    });
    return await getBase64(resized);
  }

  async function handleDrop(files: File[]) {
    const base64 = await handleResizeToBase64(files[0]);
    handleChange(base64);
  }

  async function handleDropCapture(url: string) {
    const base64 = await handleResizeToBase64(url);
    handleChange(base64);
  }

  function handleResolutionChange(upscaleValues: { upscaleWidth: number; upscaleHeight: number }) {
    if (value) {
      onChange?.({ ...value, ...upscaleValues });
    }
  }

  useEffect(() => {
    if (value && typeof value === 'string' && (value as string).length > 0) handleUrlChange(value);
  }, [value]);

  return (
    <>
      <Input.Wrapper
        {...inputWrapperProps}
        error={error ?? inputWrapperProps.error}
        className="min-h-40"
      >
        {!value ? (
          <ImageDropzone
            allowExternalImageDrop
            onDrop={handleDrop}
            count={value ? 1 : 0}
            max={1}
            maxSize={maxOrchestratorImageFileSize}
            label="Drag image here or click to select a file"
            onDropCapture={handleDropCapture}
            loading={(loading || isLoading) && !isError}
          />
        ) : (
          <div className="flex max-h-96 justify-center overflow-hidden rounded-md bg-gray-2 dark:bg-dark-6">
            <div className="relative w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={value.url}
                alt="image to refine"
                className="mx-auto max-h-full shadow-sm shadow-black"
                onLoad={() => setLoaded(true)}
              />
              {loaded && removable && (
                <CloseButton
                  color="red"
                  variant="filled"
                  className="absolute right-0 top-0 rounded-tr-none"
                  onClick={() => handleChange()}
                />
              )}
              {loaded && (
                <div className="absolute bottom-0 right-0 rounded-tl-md bg-dark-9/50 px-2 text-white">
                  {value.width} x {value.height}
                </div>
              )}
            </div>
          </div>
        )}
      </Input.Wrapper>
      {/* {value && upscale && <ResolutionSlider value={value} onChange={handleResolutionChange} />} */}
      {value && upscale && <UpscalePicker value={value} onChange={handleResolutionChange} />}
    </>
  );
}

export const InputSourceImageUpload = withController(SourceImageUpload, ({ field }) => ({
  value: field.value,
}));

export function SourceImageUploadAccordion({
  value,
  onChange,
}: {
  value?: SourceImageProps | null;
  onChange?: (value?: SourceImageProps | null) => void;
}) {
  const [checked, setChecked] = useLocalStorage({ key: 'byoi', defaultValue: value !== undefined });
  const actuallyChecked = checked || !!value;

  return (
    <Card withBorder p={0}>
      <Card.Section p="xs" className="flex items-center justify-between">
        <Text weight={500}>Start from an image</Text>
        <Switch
          checked={actuallyChecked}
          onChange={(e) => {
            const checked = e.target.checked;
            setChecked(e.target.checked);
            if (!checked) onChange?.(null);
          }}
        />
      </Card.Section>
      <Collapse in={actuallyChecked}>
        <Card.Section withBorder className="border-b-0 bg-gray-2 dark:bg-dark-6">
          <SourceImageUpload value={value} onChange={onChange} />
        </Card.Section>
      </Collapse>
    </Card>
  );
}

const upscaleMultipliers = [1.5, 2, 2.5, 3];
const upscaleResolutions = [
  { label: '2K', value: 2048 },
  { label: '4K', value: 3840 },
  // { label: '8K', value: 7680 },
];

function UpscalePicker({
  value,
  onChange,
}: {
  value: SourceImageProps;
  onChange: (args: { upscaleWidth: number; upscaleHeight: number }) => void;
}) {
  const min = Math.max(value.width, value.height);
  const _value = Math.max(value.upscaleHeight ?? 0, value.upscaleWidth ?? 0);
  function handleChange(target: number) {
    const upscaleValues = getUpscaleSizes({ ...value, target });
    onChange({ ...value, ...upscaleValues });
  }

  const multiplierOptions = useMemo(
    () =>
      upscaleMultipliers.map((multiplier) => {
        const value = Math.ceil((min * multiplier) / 64) * 64;
        return {
          value,
          label: multiplier,
          disabled: maxUpscaleSize < value,
        };
      }),
    [min]
  );

  const resolutionOptions = useMemo(
    () =>
      upscaleResolutions.map(({ label, value }) => {
        return { label, value, disabled: value <= min };
      }),
    [min]
  );

  return (
    <div className="flex flex-col gap-3">
      {(value.width === value.upscaleWidth || value.height === value.upscaleHeight) && (
        <Alert color="yellow">This image cannot be upscaled any further.</Alert>
      )}
      <Input.Wrapper label="Upscale Multiplier">
        <RadioGroup value={_value} onChange={handleChange} className="flex gap-2">
          {multiplierOptions.map(({ label, value, disabled }) => (
            <RadioInput key={value} value={value} label={label} disabled={disabled} />
          ))}
        </RadioGroup>
      </Input.Wrapper>

      <Input.Wrapper label="Upscale Resolution">
        <RadioGroup value={_value} onChange={handleChange} className="flex gap-2">
          {resolutionOptions.map(({ label, value, disabled }) => (
            <RadioInput key={value} value={value} label={label} disabled={disabled} />
          ))}
        </RadioGroup>
      </Input.Wrapper>

      <div className="rounded-md bg-gray-2 px-6 py-4 dark:bg-dark-6">
        <span className="font-bold">Upscale Dimensions:</span> {value.upscaleWidth} x{' '}
        {value.upscaleHeight}
      </div>
    </div>
  );
}

function RadioInput({
  value,
  label,
  disabled,
}: {
  value: any;
  label: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Radio
      value={value}
      disabled={disabled}
      className={clsx(
        !disabled ? 'cursor-pointer focus:outline-none' : 'cursor-not-allowed opacity-25',
        'flex flex-1 items-center justify-center rounded-md  p-3 text-sm font-semibold uppercase ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
        'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
        'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
      )}
    >
      {label}
    </Radio>
  );
}

function getUpscaleSizes({
  width,
  height,
  target,
}: {
  width: number;
  height: number;
  target: number;
}) {
  const aspectRatio = width / height;
  let upscaleWidth: number;
  let upscaleHeight: number;
  if (width > height) {
    upscaleWidth = target;
    upscaleHeight = Math.round(target / aspectRatio);
  } else {
    upscaleWidth = target * aspectRatio;
    upscaleHeight = target;
  }

  return {
    upscaleWidth: Math.ceil(upscaleWidth / 64) * 64,
    upscaleHeight: Math.ceil(upscaleHeight / 64) * 64,
  };
}

// function getUpscaleAspectRatioString(args: { width: number; height: number; target: number }) {
//   const { upscaleWidth, upscaleHeight } = getUpscaleSizes(args);
//   return `${upscaleWidth} x ${upscaleHeight}`;
// }

// function ResolutionSlider({
//   value,
//   onChange,
// }: {
//   value: SourceImageProps;
//   onChange: (value: number) => void;
// }) {
//   const { width, height } = value;
//   const min = Math.max(value.width, value.height);
//   const [_value, setValue] = useState<number>(
//     Math.max(value.upscaleHeight ?? 0, value.upscaleWidth ?? 0)
//   );
//   const [changeEndValue, setChangeEndValue] = useState<number>();

//   useEffect(() => {
//     if (!changeEndValue) return;
//     onChange?.(changeEndValue);
//   }, [changeEndValue]);

//   if (maxUpscaleSize <= min) {
//     //TODO - handle displaying that the image can't be upsized more
//     return <Alert>This image cannot be upscaled any further.</Alert>;
//   }

//   return (
//     <Input.Wrapper
//       label={
//         <div className="flex w-full items-center justify-between gap-3">
//           <span>Resolution</span>
//           <span className="font-normal">
//             {value.upscaleWidth} x {value.upscaleHeight}
//           </span>
//         </div>
//       }
//     >
//       <Slider
//         label={(value) => getUpscaleAspectRatioString({ width, height, target: value })}
//         min={min}
//         max={maxUpscaleSize}
//         value={_value}
//         onChange={setValue}
//         onChangeEnd={setChangeEndValue}
//         step={64}
//       />
//     </Input.Wrapper>
//   );
// }
