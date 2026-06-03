CREATE OR REPLACE FUNCTION is_new_user(userId INT)
RETURNS BOOLEAN AS $$
DECLARE
    isNew BOOLEAN;
BEGIN
    SELECT "createdAt" > now() - interval '2 hours'
    INTO isNew
    FROM "User"
    WHERE id = userId;

    RETURN isNew;
END;
$$ LANGUAGE plpgsql;
