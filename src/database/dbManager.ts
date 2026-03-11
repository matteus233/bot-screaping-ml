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