-- Persist offline Shopify access tokens across stateless app deployments.
-- Values are AES-256-GCM encrypted by the application before storage.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS offline_token_ciphertext TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS token_updated_at TIMESTAMPTZ;
