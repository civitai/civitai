// remix-app-creator template v1
const SPEC = {"icon":"pencil","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Redraw this image as a detailed graphite pencil sketch on paper. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]};
export default defineRemixApp({
  async run(ctx) {
    let images = [];
    ({ images } = await ctx.workflow({ kind: "image", prompt: "Redraw this image as a detailed graphite pencil sketch on paper. Don't add any text or lettering.", images: [ctx.source], aspectRatio: "source", quantity: 1 }));
    return images;
  },
});
