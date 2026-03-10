// /**
//  * MultiPromptInput
//  *
//  * Input component for multi-segment prompts (Kling V3).
//  * Each segment has a text prompt and an optional duration.
//  * Allows adding, removing, and editing prompt segments.
//  */

// import { ActionIcon, Button, Input, NumberInput, Stack, Text } from '@mantine/core';
// import { IconPlus, IconTrash } from '@tabler/icons-react';
// import type z from 'zod';
// import type { klingV3MultiPromptSchema } from '~/shared/data-graph/generation/kling-graph';
// import { AutosizeTextarea } from './AutosizeTextarea';

// // =============================================================================
// // Types
// // =============================================================================

// type KlingV3MultiPrompt = z.infer<typeof klingV3MultiPromptSchema>;

// export interface MultiPromptInputProps {
//   value: KlingV3MultiPrompt[] | null;
//   onChange: (value: KlingV3MultiPrompt[] | null) => void;
// }

// // =============================================================================
// // Component
// // =============================================================================

// export function MultiPromptInput({ value, onChange }: MultiPromptInputProps) {
//   const segments = value ?? [];

//   const addSegment = () => {
//     onChange([...segments, { prompt: '', duration: undefined }]);
//   };

//   const removeSegment = (index: number) => {
//     const updated = segments.filter((_, i) => i !== index);
//     onChange(updated.length > 0 ? updated : null);
//   };

//   const updateSegment = (index: number, update: Partial<KlingV3MultiPrompt>) => {
//     onChange(segments.map((seg, i) => (i === index ? { ...seg, ...update } : seg)));
//   };

//   return (
//     <div className="flex flex-col gap-2">
//       <Input.Label>Multi-Prompt Segments</Input.Label>
//       {segments.length === 0 && (
//         <Text size="sm" c="dimmed">
//           Add prompt segments to control different parts of the video
//         </Text>
//       )}
//       <Stack gap="xs">
//         {segments.map((segment, index) => (
//           <div key={index} className="border-solid-1 flex flex-col gap-2 rounded-md border p-3">
//             <div className="flex items-center justify-between">
//               <Text size="sm" fw={500}>
//                 Segment {index + 1}
//               </Text>
//               <ActionIcon
//                 variant="subtle"
//                 color="red"
//                 size="sm"
//                 onClick={() => removeSegment(index)}
//               >
//                 <IconTrash size={14} />
//               </ActionIcon>
//             </div>
//             <AutosizeTextarea
//               placeholder="Describe this segment..."
//               value={segment.prompt}
//               onChange={(e) => updateSegment(index, { prompt: e.target.value })}
//               size="xs"
//               autosize
//               minRows={2}
//               maxRows={4}
//             />
//             <NumberInput
//               label="Duration (seconds)"
//               placeholder="Auto"
//               value={segment.duration ?? ''}
//               onChange={(v) => updateSegment(index, { duration: v === '' ? undefined : Number(v) })}
//               size="xs"
//               min={1}
//               max={10}
//             />
//           </div>
//         ))}
//       </Stack>
//       <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={addSegment}>
//         Add Segment
//       </Button>
//     </div>
//   );
// }
