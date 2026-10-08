import { createComponent } from '@lit/react';
import * as React from 'react';
import { CivitaiPostPlanner } from './define.js';

/** React binding, the same `@lit/react` shape `@civitai/components-react` generates: props are
 *  assigned as properties (so `host` and `location` objects survive), events arrive as DOM events. */
export const PostPlanner = createComponent({
  react: React,
  tagName: 'civitai-post-planner',
  elementClass: CivitaiPostPlanner,
  events: {
    onNavigate: 'navigate',
    onRescheduled: 'rescheduled',
    onPublished: 'published',
    onUnscheduled: 'unscheduled',
    onShifted: 'shifted',
    onShowMatureChange: 'show-mature-change',
    onError: 'error',
  },
});
