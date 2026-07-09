ALTER TABLE "AuctionBase"
  ADD COLUMN "description" text;

/*
insert into "AuctionBase" (type, ecosystem, name, quantity, "minPrice", active, slug, "runForDays", "validForDays", description)
values
  ('Model', null, 'Featured Checkpoints', 200, 1000, true, 'featured-checkpoints', 7, 7, null),
  ('Model', 'SD1', 'Featured Resources - SD1', 40, 500, true, 'featured-resources-sd1', 1, 1, null),
  ('Model', 'SDXL', 'Featured Resources - SDXL', 40, 500, true, 'featured-resources-sdxl', 1, 1, null),
  ('Model', 'Pony', 'Featured Resources - Pony', 40, 500, true, 'featured-resources-pony', 1, 1, null),
  ('Model', 'Flux1', 'Featured Resources - Flux', 40, 500, true, 'featured-resources-flux', 1, 1, null),
  ('Model', 'Illustrious', 'Featured Resources - Illustrious', 40, 500, true, 'featured-resources-illustrious', 1, 1, null),
  ('Model', 'NoobAI', 'Featured Resources - NoobAI', 40, 500, true, 'featured-resources-noobai', 1, 1, null),
  ('Model', 'SD3', 'Featured Resources - SD3', 40, 500, true, 'featured-resources-sd3', 1, 1, null),
  ('Model', 'SD3_5M', 'Featured Resources - SD3.5', 40, 500, true, 'featured-resources-sd35', 1, 1, null),
  ('Model', 'Misc', 'Featured Resources - Misc', 40, 500, true, 'featured-resources-misc', 1, 1,
   'For generic model types that do not have a defined ecosystem.')
;
*/
