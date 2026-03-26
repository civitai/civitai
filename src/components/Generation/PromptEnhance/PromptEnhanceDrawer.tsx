import { CloseButton, Drawer, Group, Tabs, Text } from '@mantine/core';
import { IconHistory, IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { PromptEnhanceProps } from './triggerPromptEnhance';
import { EnhanceTab } from './EnhanceTab';
import { HistoryTab } from './HistoryTab';

export default function PromptEnhanceDrawer({
  prompt,
  negativePrompt,
  ecosystem,
  resources,
  onApply,
}: PromptEnhanceProps) {
  const dialog = useDialogContext();
  const mobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<string | null>('enhance');

  return (
    <Drawer
      {...dialog}
      position="right"
      size={mobile ? '100%' : 440}
      withCloseButton={false}
      shadow="lg"
      transitionProps={{ transition: 'slide-left' }}
      styles={{
        body: {
          height: '100%',
          padding: mobile ? 0 : 'var(--mantine-spacing-md)',
          paddingTop: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
        content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
    >
      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <Group justify="space-between" px="md" pt="md" pb={0}>
          <Text fw={600}>Prompt Enhancement</Text>
          <CloseButton onClick={dialog.onClose} />
        </Group>

        <Tabs.List px="md" mt="xs">
          <Tabs.Tab value="enhance" leftSection={<IconSparkles size={14} />}>
            Enhance
          </Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconHistory size={14} />}>
            History
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="enhance" className="flex flex-1 flex-col overflow-hidden">
          <EnhanceTab
            prompt={prompt}
            negativePrompt={negativePrompt}
            ecosystem={ecosystem}
            triggerWords={[
              ...new Set(
                (resources ?? []).flatMap((r) => r.trainedWords ?? []).filter(Boolean)
              ),
            ]}
            onApply={onApply}
          />
        </Tabs.Panel>

        {activeTab === 'history' && (
          <Tabs.Panel value="history" className="flex flex-1 flex-col overflow-hidden">
            <HistoryTab onApply={onApply} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Drawer>
  );
}
