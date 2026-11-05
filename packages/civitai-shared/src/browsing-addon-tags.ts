// Tags the main app's DEFAULT browsing add-ons hide models by. The live add-ons are a Redis value that
// can differ; Creator Studio's "listed on" badges follow these defaults.

/** Hidden from every browsing level, like a POI model. */
export const peopleBrowsingTagIds = [
  5161, //actor
  5162, //actress
  5188, //celebrity
  5249, //real person
  130818, //porn actress
  130820, //adult actress
  133182, //porn star
  130401, //deepfake
  110980, //public figure
];

/** Hidden from mature browsing, like a minor-flagged model. */
export const childBrowsingTagIds = [
  5351, //child
  306619, //child present
  154326, //toddler
  161829, //male child
  163032, //female child
];
