import {
  runFpMirror,
  runFpReconcile,
  runFpSweep,
} from '~/server/services/feature-pages/mirror.service';
import { createJob } from './job';

export const featurePagesMirror = createJob('feature-pages-mirror', '* * * * *', runFpMirror);

// Not behind the mirror flag: it must keep running while the mirror is braked; its overdue-push log is what pages.
export const featurePagesSweep = createJob('feature-pages-sweep', '*/5 * * * *', runFpSweep);

export const featurePagesReconcile = createJob(
  'feature-pages-reconcile',
  '20 5 * * *',
  runFpReconcile
);
