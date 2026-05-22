-- Per-user encryption key for cross-device memory blob sharing (SCI-220).
-- Generated on first enrollment, returned to all subsequent devices so blobs
-- encrypted on one device can be decrypted on any other enrolled device.
ALTER TABLE users ADD COLUMN IF NOT EXISTS enc_key TEXT;
