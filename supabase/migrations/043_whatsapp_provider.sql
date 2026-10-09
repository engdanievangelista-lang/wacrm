-- 043: WhatsApp provider support (Meta Cloud API + UAZAPI)
--
-- Adds a `provider` discriminator to whatsapp_config so a second provider
-- can coexist with Meta. Existing rows default to 'meta'. Idempotent.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS provider_config JSONB,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

-- UAZAPI rows have no phone_number_id. waba_id was already nullable (001).
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;

-- Meta rows must still carry a phone_number_id.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_meta_requires_phone_number_id;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_meta_requires_phone_number_id
  CHECK (provider <> 'meta' OR phone_number_id IS NOT NULL);

-- Widen status (inline CHECK from 001 is auto-named whatsapp_config_status_check).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'connecting', 'disconnected'));

-- Per-config webhook secret (nullable; NULLs do not collide).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_webhook_secret_key
  ON whatsapp_config (webhook_secret)
  WHERE webhook_secret IS NOT NULL;
