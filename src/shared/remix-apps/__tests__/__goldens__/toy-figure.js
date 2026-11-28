// remix-app-creator template v1
const SPEC = {"icon":"toy","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Turn the subject into a collectible toy figure in its packaging box, product photo. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]};
export default defineRemixApp({
  async run(ctx) {
    let images = [];
    ({ images } = await ctx.workflow({ kind: "image", prompt: "Turn the subject into a collectible toy figure in its packaging box, product photo. Don't add any text or lettering.", images: [ctx.source], aspectRatio: "source", quantity: 1 }));
    return images;
  },
});
