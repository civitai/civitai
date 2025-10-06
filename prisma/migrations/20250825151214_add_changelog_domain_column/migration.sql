-- AlterTable
ALTER TABLE "public"."Changelog" ADD COLUMN     "domain" "public"."DomainColor"[] DEFAULT ARRAY['all']::"public"."DomainColor"[];
