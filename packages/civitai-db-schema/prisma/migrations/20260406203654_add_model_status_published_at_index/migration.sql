-- CreateIndex
-- Add CONCURRENTLY when running against a production database to avoid locking the table
CREATE INDEX "Model_status_publishedAt_idx" ON "Model" (status, "publishedAt");

-- Post-deploy action needed                                                                                                                                                    
                                                                                                                                                                            
-- Reset the stuck cursors in the KeyValue table:                                                                                                                               
-- UPDATE "KeyValue"                                                                                                                                                          
-- SET value = EXTRACT(EPOCH FROM (NOW() - INTERVAL '10 minutes')) * 1000
-- WHERE key IN (                                                                                                                                                               
--   'last-sent-notification-new-model-from-following',
--   'last-sent-notification-new-model-version'                                                                                                                                 
-- ); 
