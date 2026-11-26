/** The owner of every system home block (`getSystemHomeBlocks`); a clone's `source` carries it. */
const SYSTEM_HOME_BLOCK_USER_ID = -1;

type ListedHomeBlock = {
  id: number;
  sourceId?: number | null;
  /** The source row's owner, as `homeBlock.getHomeBlocks` lists it for a viewer's own blocks. */
  source?: { userId: number } | null;
};

/**
 * The id to read a home block's content by (`homeBlock.getHomeBlock`). A clone of a system block
 * renders its source's content: the server resolves the clone to the source's metadata and serves
 * both from one shared cache entry, and no block component reads the identity fields of the
 * answer. So a clone reads by its source's id, which every viewer of that block shares, and its
 * read can be served from the edge cache instead of being unique to this viewer. The page still
 * places and keys the block by its own row. Anything else reads by its own id: the system block
 * itself, a viewer's own block, and a clone whose source is not known to be a system block.
 */
export function homeBlockContentId(homeBlock: ListedHomeBlock) {
  const { id, sourceId, source } = homeBlock;
  return sourceId != null && source?.userId === SYSTEM_HOME_BLOCK_USER_ID ? sourceId : id;
}
