-- AlterTable
CREATE SEQUENCE collection_id_seq;
ALTER TABLE "Collection" ALTER COLUMN "id" SET DEFAULT nextval('collection_id_seq');
ALTER SEQUENCE collection_id_seq OWNED BY "Collection"."id";

-- AlterTable
CREATE SEQUENCE collectionitem_id_seq;
ALTER TABLE "CollectionItem" ALTER COLUMN "id" SET DEFAULT nextval('collectionitem_id_seq');
ALTER SEQUENCE collectionitem_id_seq OWNED BY "CollectionItem"."id";

-- AlterTable
CREATE SEQUENCE homeblock_id_seq;
ALTER TABLE "HomeBlock" ALTER COLUMN "id" SET DEFAULT nextval('homeblock_id_seq');
ALTER SEQUENCE homeblock_id_seq OWNED BY "HomeBlock"."id";
