import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import { newAppKey } from '~/components/Apps/AppAssistant/appKey';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';

export const CREATE_APP = 'create_app';

/** What the assistant reads when it tries to plan features before there is an app to build them in. */
export const NO_APP_REFUSAL =
  'No app is open, so nothing could be built. Call create_app with a short name for the app the user described first.';

export interface AppToolsOptions {
  /** The user's apps as last listed; undefined until the list has loaded. */
  apps: () => Sandbox[] | undefined;
  /** Creates the app's sandbox and makes it the open app. */
  open: (app: string) => Promise<Sandbox>;
}

/** `create_app`: how a new user's first build request gets an app, with no setup step of their own. */
export function createAppTools({ apps, open }: AppToolsOptions): Record<string, ChatTool> {
  const create_app: ChatTool = {
    description:
      'Start a new app for the user and open it. Call it once, before anything else, when the user describes an app to build and no app is open, or when they ask for a different app than the open one. Never call it for a question that builds nothing.',
    activity: 'Setting up your app…',
    inputSchema: {
      properties: {
        name: {
          type: 'string',
          description:
            'A short name for the app in two to four words, taken from the user’s request, e.g. "Tip calculator". It becomes the app’s id.',
        },
      },
      required: ['name'],
    },
    async execute(input) {
      const list = apps();
      if (!list) throw new Error('The user’s apps have not loaded yet. Try again in a moment.');
      const app = newAppKey(
        typeof input.name === 'string' ? input.name : '',
        list.map((s) => s.app)
      );
      try {
        const sandbox = await open(app);
        return {
          app,
          state: sandbox.state,
          note: `The app ${app} is starting, and ${app} is also its blockId. Its tools arrive with your next reply, so call set_checklist now with the features the user asked for; that ends this reply.`,
        };
      } catch (error) {
        if (error instanceof SandboxApiError && error.kind === 'limit')
          throw new Error(
            /running/.test(error.message)
              ? `Another of the user’s apps is still running (${error.message}). Tell them to pause it under Your apps at the top of the page, then ask again. Do not call create_app again in this reply.`
              : `The user keeps the most apps they may (${error.message}). Tell them to delete one under Your apps at the top of the page, then ask again. Do not call create_app again in this reply.`
          );
        throw error;
      }
    },
  };
  return { [CREATE_APP]: create_app };
}
