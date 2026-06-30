-- Thrown together with chatGPT :^) -Manuel

CREATE OR REPLACE FUNCTION hamming_distance_bigint(hash1 bigint, hash2 bigint)
RETURNS INTEGER AS $$
DECLARE
    xor_result bigint;
    bit_count INTEGER := 0;
    bit_pos INTEGER;
BEGIN
    -- Compute XOR of the two bigint hashes
    xor_result := hash1 # hash2;

    -- Loop through each bit position (from 1 to 64)
    FOR bit_pos IN 0..63 LOOP
        -- Check if the bit at the current position is set
        IF (xor_result >> bit_pos) & 1 = 1 THEN
            bit_count := bit_count + 1;
        END IF;
    END LOOP;

    RETURN bit_count;
END;
$$ LANGUAGE plpgsql;
