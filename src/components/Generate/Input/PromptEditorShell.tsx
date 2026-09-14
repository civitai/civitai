import type { InputWrapperProps } from '@mantine/core';
import { Button, Divider, Input, Paper, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';

/** Pass the editor `className="!border-0 !bg-transparent"` so the Paper is the only border. */
export function PromptEditorShell({
  label,
  error,
  triggerWords,
  children,
}: {
  label?: InputWrapperProps['label'];
  error?: InputWrapperProps['error'];
  triggerWords?: string[];
  children: ReactNode;
}) {
  return (
    <Input.Wrapper styles={{ label: { width: '100%' } }} label={label} error={error}>
      <Paper
        radius="md"
        withBorder
        data-tour="gen:prompt"
        className="bg-white focus-within:border-blue-6 dark:bg-dark-6 dark:focus-within:border-blue-8"
      >
        {children}
        <TriggerWordsStrip triggerWords={triggerWords} />
      </Paper>
    </Input.Wrapper>
  );
}

export function TriggerWordsStrip({ triggerWords }: { triggerWords?: string[] }) {
  if (!triggerWords?.length) return null;

  return (
    <div className="mb-1 flex flex-col gap-2 px-2">
      <Divider />
      <Text c="dimmed" className="text-xs font-semibold">
        Trigger words
      </Text>
      <div className="mb-2 flex items-center gap-1">
        <TrainedWords
          type="LORA"
          trainedWords={triggerWords}
          badgeProps={{
            style: {
              textTransform: 'none',
              height: 'auto',
              cursor: 'pointer',
            },
          }}
        />
        <CopyButton value={triggerWords.join(', ')}>
          {({ copied, copy, Icon, color }) => (
            <Button
              variant="subtle"
              color={color ?? 'blue.5'}
              onClick={copy}
              size="compact-xs"
              classNames={{ root: 'shrink-0', inner: 'flex gap-1' }}
            >
              {copied ? 'Copied' : 'Copy All'} <Icon size={14} />
            </Button>
          )}
        </CopyButton>
      </div>
    </div>
  );
}
