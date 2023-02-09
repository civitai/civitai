-- AlterTable
CREATE SEQUENCE cosmetic_id_seq;
ALTER TABLE "Cosmetic" ALTER COLUMN "id" SET DEFAULT nextval('cosmetic_id_seq');
ALTER SEQUENCE cosmetic_id_seq OWNED BY "Cosmetic"."id";
