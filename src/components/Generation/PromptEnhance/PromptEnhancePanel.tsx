import { Tabs } from '@mantine/core';
import { IconHistory, IconSparkles } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { EnhanceTab } from './EnhanceTab';
import { HistoryTab, type RemixData } from './HistoryTab';

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
  const [remixData, setRemixData] = useState<RemixData | null>(null);

  const handleRemix = useCallback((data: RemixData) => {
    setRemixData(data);
    setActiveTab('enhance');
  }, []);

  // Use remix data if available, otherwise fall back to props
  const enhancePrompt = remixData?.prompt ?? prompt;
  const enhanceNegativePrompt = remixData?.negativePrompt ?? negativePrompt;
  const enhanceInstruction = remixData?.instruction;

  return (
    <Tabs
      value={activeTab}
      onChange={setActiveTab}
      keepMounted
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

      <Tabs.Panel value="enhance" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <EnhanceTab
          key={remixData ? `remix-${Date.now()}` : 'default'}
          prompt={enhancePrompt}
          negativePrompt={enhanceNegativePrompt}
          instruction={enhanceInstruction}
          ecosystem={ecosystem}
          triggerWords={triggerWords}
          onApply={onApply}
          onBack={onBack}
        />
      </Tabs.Panel>

      <Tabs.Panel value="history" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <HistoryTab onApply={onApply} onRemix={handleRemix} />
      </Tabs.Panel>
    </Tabs>
  );
}
