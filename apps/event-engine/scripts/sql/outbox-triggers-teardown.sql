-- Teardown script for Outbox Triggers

-- Drop Model Triggers
DROP TRIGGER IF EXISTS outbox_model_deleted_on_update ON "Model";
DROP TRIGGER IF EXISTS outbox_model_deleted_on_delete ON "Model";
DROP TRIGGER IF EXISTS outbox_model_publish_status ON "Model";

-- Drop Model Functions
DROP FUNCTION IF EXISTS outbox_model_deleted_trigger();
DROP FUNCTION IF EXISTS outbox_model_deleted_on_delete_trigger();
DROP FUNCTION IF EXISTS outbox_model_publish_trigger();

-- Drop ModelVersion Triggers
DROP TRIGGER IF EXISTS outbox_model_version_publish_status ON "ModelVersion";

-- Drop ModelVersion Functions
DROP FUNCTION IF EXISTS outbox_model_version_publish_trigger();

-- Drop Post Triggers
DROP TRIGGER IF EXISTS outbox_post_publish_status ON "Post";
DROP TRIGGER IF EXISTS outbox_post_deleted_on_delete ON "Post";

-- Drop Post Functions
DROP FUNCTION IF EXISTS outbox_post_publish_trigger();
DROP FUNCTION IF EXISTS outbox_post_deleted_trigger();

-- Drop Image Triggers
DROP TRIGGER IF EXISTS outbox_image_cover_change ON "Image";
DROP TRIGGER IF EXISTS outbox_image_to_scan ON "Image";

-- Drop Image Functions
DROP FUNCTION IF EXISTS outbox_image_cover_change_trigger();
DROP FUNCTION IF EXISTS outbox_image_to_scan_trigger();