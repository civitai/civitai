import type { SegmentedControlProps } from '@mantine/core';
import { SegmentedControl } from '@mantine/core';
import { forwardRef } from 'react';
import { withController } from '~/libs/form/hoc/withController';

// function VideoProcess(props: Omit<SegmentedControlProps, 'data'>) {
//   return (
//     <SegmentedControl
//       {...props}
//       color="blue"
//       data={[
//         { label: 'Text to Video', value: 'txt2vid' },
//         { label: 'Image to Video', value: 'img2vid' },
//       ]}
//     />
//   );
// }

const VideoProcess = forwardRef<HTMLDivElement, Omit<SegmentedControlProps, 'data'>>(
  (props, ref) => {
    return (
      <SegmentedControl
        ref={ref}
        {...props}
        color="blue"
        data={[
          { label: 'Text to Video', value: 'txt2vid' },
          { label: 'Image to Video', value: 'img2vid' },
        ]}
      />
    );
  }
);

VideoProcess.displayName = 'VideoProcess';

export const InputVideoProcess = withController(VideoProcess);

// export function VideoProcess() {
//   const process = useGenerationFormStore((state) => state.videoProcess);
//   function handleChange(value: string) {
//     useGenerationFormStore.setState({ videoProcess: value as any });
//   }

//   return (
//     <SegmentedControl
//       color="blue"
//       value={process}
//       onChange={handleChange}
//       data={[
//         { label: 'Text to Video', value: 'txt2vid' },
//         { label: 'Image to Video', value: 'img2vid' },
//       ]}
//     />
//   );
// }
