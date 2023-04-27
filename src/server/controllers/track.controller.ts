import { Context } from '~/server/createContext';
import { AddViewSchema } from '../schema/track.schema';

export async function addViewHandler({ input, ctx }: { input: AddViewSchema; ctx: Context }) {
  await ctx.track.view(input);
}
