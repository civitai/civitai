 SELECT "Image"."postId",
    bool_or(("Image".ingestion = 'Scanned'::"ImageIngestionStatus")) AS scanned
   FROM "Image"
  GROUP BY "Image"."postId";