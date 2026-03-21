// src/database/dbManager.ts — Gerenciador PostgreSQL (pg Pool, totalmente assíncrono)
import { Pool, type PoolClient } from "pg";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import type { NotificationChannel } from "../types/index.ts";

export class DatabaseManager {
  private readonly pool: Pool;

  constructor(connectionString = config.databaseUrl) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: connectionString.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
    });

    this.pool.on("error", (err) => {
      logger.error("Erro inesperado no pool PostgreSQL:", err);
    });
  }

  // ──────────────────────────────────────────────
  //  Inicialização — cria tabelas se não existirem
  // ──────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id          BIGSERIAL PRIMARY KEY,
        item_id     TEXT        NOT NULL,
        shop_id     TEXT        NOT NULL,
        price       NUMERIC(12,2) NOT NULL,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_price_item
        ON price_history(item_id, shop_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS sent_products (
        id          BIGSERIAL PRIMARY KEY,
        item_id     TEXT        NOT NULL,
        shop_id     TEXT        NOT NULL,
        channel     TEXT        NOT NULL,
        sent_at     TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_sent UNIQUE (item_id, shop_id, channel)
      );

      CREATE TABLE IF NOT EXISTS bot_config (
        key         TEXT PRIMARY KEY,
        value       TEXT        NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alert_subscriptions (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT     NOT NULL,
        chat_id     BIGINT     NOT NULL,
        keyword     TEXT,
        item_id     TEXT,
        shop_id     TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alert_notifications (
        user_id     BIGINT     NOT NULL,
        item_id     TEXT       NOT NULL,
        shop_id     TEXT       NOT NULL,
        notified_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_alert_notify UNIQUE (user_id, item_id, shop_id)
      );
    `);

    logger.info("✅ Banco de dados (PostgreSQL) inicializado.");
  }

  // ──────────────────────────────────────────────
  //  Helpers internos
  // ──────────────────────────────────────────────

  private async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<T>(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /** Executa múltiplas queries dentro de uma única transação. */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ──────────────────────────────────────────────
  //  Histórico de preços
  // ──────────────────────────────────────────────

  async recordPrice(itemId: string, shopId: string, price: number): Promise<void> {
    await this.query(
      "INSERT INTO price_history (item_id, shop_id, price) VALUES ($1, $2, $3)",
      [itemId, shopId, price],
    );
  }

  async getHistoricalMinPrice(
    itemId: string,
    shopId: string,
    days = 90,
  ): Promise<number | null> {
    const rows = await this.query<{ min_price: string | null }>(
      `SELECT MIN(price) AS min_price
       FROM price_history
       WHERE item_id = $1
         AND shop_id = $2
         AND recorded_at >= NOW() - ($3 || ' days')::INTERVAL`,
      [itemId, shopId, days],
    );

    const raw = rows[0]?.min_price;
    return raw !== null && raw !== undefined ? parseFloat(raw) : null;
  }

  async getPriceTrend(
    itemId: string,
    shopId: string,
    limit = 30,
  ): Promise<Array<{ date: string; price: number }>> {
    const rows = await this.query<{ date: string; price: string }>(
      `SELECT recorded_at AS date, price
       FROM price_history
       WHERE item_id = $1 AND shop_id = $2
       ORDER BY recorded_at DESC
       LIMIT $3`,
      [itemId, shopId, limit],
    );

    return rows.map((r) => ({ date: r.date, price: parseFloat(r.price) }));
  }

  // ──────────────────────────────────────────────
  //  Anti-spam (controle de envios)
  // ──────────────────────────────────────────────

  async wasSent(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<boolean> {
    const rows = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sent_products
         WHERE item_id = $1
           AND shop_id = $2
           AND channel = $3
           AND sent_at >= NOW() - ($4 || ' hours')::INTERVAL
       ) AS exists`,
      [itemId, shopId, channel, cooldownHours],
    );

    return rows[0]?.exists === true;
  }

  async wasSentItem(
    itemId: string,
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<boolean> {
    const rows = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sent_products
         WHERE item_id = $1
           AND channel = $2
           AND sent_at >= NOW() - ($3 || ' hours')::INTERVAL
       ) AS exists`,
      [itemId, channel, cooldownHours],
    );

    return rows[0]?.exists === true;
  }

  async wasSentAnyItem(
    itemIds: string[],
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<boolean> {
    if (itemIds.length === 0) return false;
    const rows = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sent_products
         WHERE item_id = ANY ($1::text[])
           AND channel = $2
           AND sent_at >= NOW() - ($3 || ' hours')::INTERVAL
       ) AS exists`,
      [itemIds, channel, cooldownHours],
    );
    return rows[0]?.exists === true;
  }
  async markAsSent(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
  ): Promise<void> {
    await this.query(
      `INSERT INTO sent_products (item_id, shop_id, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_sent
       DO UPDATE SET sent_at = NOW()`,
      [itemId, shopId, channel],
    );
  }

  async countSentBetween(
    channel: NotificationChannel,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM sent_products
       WHERE channel = $1
         AND sent_at >= $2
         AND sent_at < $3`,
      [channel, start.toISOString(), end.toISOString()],
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async getRecentSentKeys(
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<Set<string>> {
    const rows = await this.query<{ item_id: string; shop_id: string }>(
      `SELECT item_id, shop_id
       FROM sent_products
       WHERE channel = $1
         AND sent_at >= NOW() - ($2 || ' hours')::INTERVAL`,
      [channel, cooldownHours],
    );
    const set = new Set<string>();
    for (const r of rows) {
      set.add(`${r.item_id}:${r.shop_id}`);
    }
    return set;
  }

  async getRecentSentItemIds(
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<Set<string>> {
    const rows = await this.query<{ item_id: string }>(
      `SELECT DISTINCT item_id
       FROM sent_products
       WHERE channel = $1
         AND sent_at >= NOW() - ($2 || ' hours')::INTERVAL`,
      [channel, cooldownHours],
    );
    const set = new Set<string>();
    for (const r of rows) set.add(r.item_id);
    return set;
  }

  async cleanupSentOlderThan(days = 90): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM sent_products
         WHERE sent_at < NOW() - ($1 || ' days')::INTERVAL
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [days],
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async addAlert(params: {
    userId: number;
    chatId: number;
    keyword?: string;
    itemId?: string;
    shopId?: string;
  }): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `INSERT INTO alert_subscriptions (user_id, chat_id, keyword, item_id, shop_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        params.userId,
        params.chatId,
        params.keyword ?? null,
        params.itemId ?? null,
        params.shopId ?? null,
      ],
    );
    return parseInt(rows[0]?.id ?? "0", 10);
  }

  async listAlerts(
    userId: number,
  ): Promise<Array<{ id: number; keyword: string | null; itemId: string | null; shopId: string | null }>> {
    const rows = await this.query<{ id: string; keyword: string | null; item_id: string | null; shop_id: string | null }>(
      `SELECT id, keyword, item_id, shop_id
       FROM alert_subscriptions
       WHERE user_id = $1
       ORDER BY id DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: parseInt(r.id, 10),
      keyword: r.keyword,
      itemId: r.item_id,
      shopId: r.shop_id,
    }));
  }

  async removeAlert(userId: number, id: number): Promise<boolean> {
    const rows = await this.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM alert_subscriptions
         WHERE user_id = $1 AND id = $2
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [userId, id],
    );
    return parseInt(rows[0]?.count ?? "0", 10) > 0;
  }

  async clearAlerts(userId: number): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM alert_subscriptions
         WHERE user_id = $1
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [userId],
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async getAlertsToNotify(params: {
    itemId: string;
    shopId: string;
    name: string;
  }): Promise<Array<{ userId: number; chatId: number; keyword: string | null; itemId: string | null; shopId: string | null }>> {
    const rows = await this.query<{
      id: string;
      user_id: string;
      chat_id: string;
      keyword: string | null;
      item_id: string | null;
      shop_id: string | null;
    }>(
      `SELECT id, user_id, chat_id, keyword, item_id, shop_id
       FROM alert_subscriptions
       WHERE (item_id = $1 AND (shop_id = $2 OR shop_id IS NULL OR shop_id = '0'))
          OR (keyword IS NOT NULL AND $3 ILIKE '%' || keyword || '%')`,
      [params.itemId, params.shopId, params.name],
    );

    const toNotify: Array<{ userId: number; chatId: number; keyword: string | null; itemId: string | null; shopId: string | null }> = [];
    for (const r of rows) {
      const inserted = await this.query<{ id: string }>(
        `INSERT INTO alert_notifications (user_id, item_id, shop_id)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT uq_alert_notify DO NOTHING
         RETURNING user_id`,
        [parseInt(r.user_id, 10), params.itemId, params.shopId],
      );
      if (inserted.length > 0) {
        toNotify.push({
          userId: parseInt(r.user_id, 10),
          chatId: parseInt(r.chat_id, 10),
          keyword: r.keyword,
          itemId: r.item_id,
          shopId: r.shop_id,
        });
      }
    }

    return toNotify;
  }

  // ──────────────────────────────────────────────
  //  Configuração dinâmica do bot
  // ──────────────────────────────────────────────

  async setConfig(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO bot_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  async getConfig(key: string, defaultValue = ""): Promise<string> {
    const rows = await this.query<{ value: string }>(
      "SELECT value FROM bot_config WHERE key = $1",
      [key],
    );
    return rows[0]?.value ?? defaultValue;
  }

  // ──────────────────────────────────────────────
  //  Lifecycle
  // ──────────────────────────────────────────────

  async close(): Promise<void> {
    await this.pool.end();
    logger.info("Pool PostgreSQL encerrado.");
  }

  /** Retorna métricas do pool (útil para /status). */
  poolStats(): { total: number; idle: number; waiting: number } {
    return {
      total:   this.pool.totalCount,
      idle:    this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}
