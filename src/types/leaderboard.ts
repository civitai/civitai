import { MetricType } from './metrics';

export interface LeaderboardMetric {
  type: MetricType;
  value?: number;
  name: string;
  description?: string;
  display?: boolean;
}
