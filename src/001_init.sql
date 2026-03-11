-- db/001_init.sql — Schema inicial do Shopee Promo Bot
-- Execute: psql $DATABASE_URL -f db/001_init.sql

-- ──────────────────────────────────────────────
--  Histórico de preços
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id          BIGSERIAL PRIMARY KEY,
  item_id     TEXT           NOT NULL,
  shop_id     TEXT           NOT NULL,
  price       NUMERIC(12, 2) NOT NULL,
  recorded_at TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_item
  ON price_history(item_id, shop_id, recorded_at DESC);

-- ──────────────────────────────────────────────
--  Produtos já enviados (anti-spam)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sent_products (
  id          BIGSERIAL PRIMARY KEY,
  item_id     TEXT        NOT NULL,
  shop_id     TEXT        NOT NULL,
  channel     TEXT        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sent UNIQUE (item_id, shop_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_sent_at
  ON sent_products(sent_at DESC);

-- ──────────────────────────────────────────────
--  Configurações dinâmicas do bot
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_config (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Valores padrão
INSERT INTO bot_config (key, value) VALUES
  ('minDiscountPercent', '20'),
  ('maxPriceBRL',        '500'),
  ('minRating',          '4.0'),
  ('minSales',           '100')
ON CONFLICT (key) DO NOTHING;