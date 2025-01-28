import { Step } from 'react-joyride';

export interface StepData {
  onNext?: (opts?: { isMobile?: boolean }) => Promise<void>;
  onPrev?: (opts?: { isMobile?: boolean }) => Promise<void>;
}

export type StepWithData = Step & { data?: StepData };
