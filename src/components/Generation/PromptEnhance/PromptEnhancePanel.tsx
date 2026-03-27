import { Tabs } from '@mantine/core';
import { IconHistory, IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { EnhanceTab } from './EnhanceTab';
import { HistoryTab } from './HistoryTab';

type PromptEnhancePanelProps = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  triggerWords?: string[];
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
  onBack?: () => void;
};

export function PromptEnhancePanel({
  prompt,
  negativePrompt,
  ecosystem,
  triggerWords,
  onApply,
  onBack,
}: PromptEnhancePanelProps) {
  const [activeTab, setActiveTab] = useState<string | null>('enhance');

  return (
    <Tabs
      value={activeTab}
      onChange={setActiveTab}
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      <Tabs.List px="md" mt="xs">
        <Tabs.Tab value="enhance" leftSection={<IconSparkles size={14} />}>
          Enhance
        </Tabs.Tab>
        <Tabs.Tab value="history" leftSection={<IconHistory size={14} />}>
          History
        </Tabs.Tab>
      </Tabs.List>

      {activeTab === 'enhance' && (
        <Tabs.Panel value="enhance" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <EnhanceTab
            prompt={prompt}
            negativePrompt={negativePrompt}
            ecosystem={ecosystem}
            triggerWords={triggerWords}
            onApply={onApply}
            onBack={onBack}
          />
        </Tabs.Panel>
      )}

      {activeTab === 'history' && (
        <Tabs.Panel value="history" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <HistoryTab onApply={onApply} />
        </Tabs.Panel>
      )}
    </Tabs>
  );
}
