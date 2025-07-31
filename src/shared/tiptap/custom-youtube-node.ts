import { YoutubeNode } from '~/components/TipTap/YoutubeNode';
export const CustomYoutubeNode = YoutubeNode.extend({
  // @ts-ignore
  renderHTML(input) {
    const { HTMLAttributes } = input;
    // @ts-ignore
    if (!HTMLAttributes.src || !this.parent) return ['div', { 'data-youtube-video': '' }];
    // @ts-ignore
    return this.parent(input);
  },
});
