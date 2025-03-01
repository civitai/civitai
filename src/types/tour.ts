import type { Step } from 'react-joyride';

export interface StepData {
  onNext?: () => Promise<void>;
  onPrev?: () => Promise<void>;
  onBeforeStart?: () => Promise<void>;
}

export type StepWithData = Step & { data?: StepData };
