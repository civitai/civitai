/**
 * The DBOS calls a reply makes, as `reply-dbos-calls.pg.test.ts` reads them back from DBOS's own
 * tables: what a crashed run's recovery replays against. Recorded on the runner as it was before
 * its generic code moved to `src/core/`; that move must not change a line of it.
 *
 * A change here changes what a recovered run replays: bump `WORKFLOW_VERSION` with it.
 */
export const GOLDEN: Record<string, unknown> = {
  done: {
    workflows: [
      {
        id: '<run>',
        name: 'reply',
        status: 'SUCCESS',
        application_version: 'reply-1',
        queue_name: 'replies',
        authenticated_user: 'golden-done',
        class_name: null,
        config_name: null,
        workflow_timeout_ms: 120000,
        deduplication_id: null,
      },
    ],
    operations: [
      {
        id: 0,
        name: 'begin',
        child: null,
        failed: false,
      },
      {
        id: 1,
        name: 'pass',
        child: null,
        failed: false,
      },
      {
        id: 2,
        name: 'DBOS.recv',
        child: null,
        output: '{"json":"done","__dbos_serializer":"superjson"}',
        failed: false,
      },
      {
        id: 3,
        name: 'DBOS.sleep',
        child: null,
        failed: false,
      },
      {
        id: 4,
        name: 'DBOS.send',
        child: null,
        failed: false,
      },
    ],
    streams: [
      {
        key: 'events',
        function_id: 1,
      },
    ],
    notifications: [
      {
        topic: 'control',
        message: '{"json":"done","__dbos_serializer":"superjson"}',
        consumed: true,
      },
    ],
    journal: {
      types: ['run-started', 'text-delta', 'tool-call', 'tool-result', 'text-delta', 'run-ended'],
      ended: {
        status: 'done',
        steps: 2,
      },
    },
    output: {
      status: 'done',
      steps: 2,
      resume: false,
    },
  },
  stopped: {
    workflows: [
      {
        id: '<run>',
        name: 'reply',
        status: 'SUCCESS',
        application_version: 'reply-1',
        queue_name: 'replies',
        authenticated_user: 'golden-stop',
        class_name: null,
        config_name: null,
        workflow_timeout_ms: 120000,
        deduplication_id: null,
      },
    ],
    operations: [
      {
        id: 0,
        name: 'begin',
        child: null,
        failed: false,
      },
      {
        id: 1,
        name: 'pass',
        child: null,
        failed: false,
      },
      {
        id: 2,
        name: 'DBOS.recv',
        child: null,
        output: '{"json":"stop","__dbos_serializer":"superjson"}',
        failed: false,
      },
      {
        id: 3,
        name: 'DBOS.sleep',
        child: null,
        failed: false,
      },
      {
        id: 4,
        name: 'DBOS.send',
        child: null,
        failed: false,
      },
    ],
    streams: [
      {
        key: 'events',
        function_id: 1,
      },
    ],
    notifications: [
      {
        topic: 'control',
        message: '{"json":"done","__dbos_serializer":"superjson"}',
        consumed: false,
      },
      {
        topic: 'control',
        message: '{"json":"stop","__dbos_serializer":"superjson"}',
        consumed: true,
      },
    ],
    journal: {
      first: 'run-started',
      last: 'run-ended',
      ended: {
        status: 'stopped',
        steps: 1,
      },
    },
    output: {
      status: 'stopped',
      steps: 1,
      resume: false,
    },
  },
  'stopped-before-start': {
    workflows: [
      {
        id: '<run>',
        name: 'reply',
        status: 'SUCCESS',
        application_version: 'reply-1',
        queue_name: 'replies',
        authenticated_user: 'golden-marker',
        class_name: null,
        config_name: null,
        workflow_timeout_ms: 120000,
        deduplication_id: null,
      },
      {
        id: '<run>.stop',
        name: 'reply-stop-marker',
        status: 'SUCCESS',
        application_version: 'reply-1',
        queue_name: null,
        authenticated_user: 'golden-marker',
        class_name: null,
        config_name: null,
        workflow_timeout_ms: null,
        deduplication_id: null,
      },
    ],
    operations: [
      {
        id: 0,
        name: 'begin',
        child: null,
        failed: false,
      },
      {
        id: 1,
        name: 'pass',
        child: null,
        failed: false,
      },
      {
        id: 2,
        name: 'DBOS.recv',
        child: null,
        output: '{"json":"done","__dbos_serializer":"superjson"}',
        failed: false,
      },
      {
        id: 3,
        name: 'DBOS.sleep',
        child: null,
        failed: false,
      },
      {
        id: 4,
        name: 'DBOS.send',
        child: null,
        failed: false,
      },
    ],
    streams: [
      {
        key: 'events',
        function_id: 1,
      },
    ],
    notifications: [
      {
        topic: 'control',
        message: '{"json":"done","__dbos_serializer":"superjson"}',
        consumed: true,
      },
    ],
    journal: {
      types: ['run-started', 'run-ended'],
      ended: {
        status: 'stopped',
        steps: 0,
      },
    },
    output: {
      status: 'stopped',
      steps: 0,
      resume: false,
    },
  },
};
