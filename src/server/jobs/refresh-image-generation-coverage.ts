import { refreshGenerationCoverage as invocation } from '../services/generation/generation.service';
import { createJob } from './job';

export const refreshImageGenerationCoverage = createJob(
  'refresh-image-generation-coverage',
  '*/15 * * * *',
  invocation
);
