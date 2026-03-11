// src/scheduler.ts — Orquestrador ML (Telegram only)
import cron from "node-cron";
import { config, filterConfig } from "./config.ts";
import { MLClient } from "./api/mlClient.ts";
import { tokenManager } from "./api/tokenManager.ts";
import { ProductFilter } from "./filters/productFilter.ts";
import { DatabaseManager } from "./database/dbManager.ts";
import { TelegramNotifier } from "./notifiers/telegramNotifier.ts";
import { logger } from "./utils/logger.ts";
import { ML_CATEGORIES } from "./types/index.ts";
import type { MLProduct } from "./types/index.ts";

const SEND_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MLBot {
  private readonly db:       DatabaseManager;
  private readonly api:      MLClient;
  private readonly filter:   ProductFilter;
  private readonly telegram: TelegramNotifier;
  private running = false;
  private cronJob: ReturnType<typeof cron.schedule> | null = null;

  constructor() {
    this.db       = new DatabaseManager();
    this.api      = new MLClient();
    this.filter   = new ProductFilter(this.db);
    this.telegram = new TelegramNotifier(this.db);
  }

  async runCycle(): Promise<void> {
    if (this.running) { logger.warn("Ciclo ML em execução. Pulando."); return; }
    this.running = true;
    logger.info("🔄 [ML] Iniciando ciclo...");

    try {
      const categories = filterConfig.allowedCategories.length > 0
        ? filterConfig.allowedCategories
        : Object.keys(ML_CATEGORIES).filter((k) => k !== "todas");

      const all: MLProduct[] = [];
      const seen = new Set<string>();

      for (const cat of categories) {
        const items = await this.api.fetchAllDeals({ categoryKey: cat, maxPages: 3 });
        for (const item of items) {
          if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
        }
      }

      logger.info(`[ML] Total único: ${all.length}`);
      const valid = await this.filter.filterProducts(all);

      let sent = 0;
      for (const product of valid) {
        const ok = await this.telegram.sendProduct(product, product.permalink);
        if (ok) { sent++; await sleep(SEND_DELAY_MS); }
      }

      logger.info(`[ML] Ciclo concluído: ${sent} enviados.`);
    } catch (err) {
      logger.error("[ML] Erro no ciclo:", err);
    } finally {
      this.running = false;
    }
  }

  async start(): Promise<void> {
    logger.info("🚀 ML Promo Bot iniciando...");

    await this.db.initialize();
    await this.loadSavedConfig();

    const hasToken = Boolean(config.ml.accessToken);
    if (!hasToken) {
      logger.warn("ML_ACCESS_TOKEN não configurado. Acesse para autorizar:");
      logger.warn(tokenManager.getAuthorizationUrl());
    }

    this.telegram.startPolling();

    if (hasToken) await this.runCycle();

    const interval = config.rateLimit.fetchIntervalMinutes;
    this.cronJob = cron.schedule(`*/${interval} * * * *`, () => {
      this.runCycle().catch((err) => logger.error("[ML] Erro agendado:", err));
    });

    logger.info(`Ciclos a cada ${interval} min.`);
    process.on("SIGINT",  () => this.stop("SIGINT"));
    process.on("SIGTERM", () => this.stop("SIGTERM"));
  }

  stop(signal = "manual"): void {
    logger.info(`[ML] Encerrando (${signal})...`);
    this.cronJob?.stop();
    this.telegram.stopPolling();
    this.db.close().finally(() => process.exit(0));
  }

  private async loadSavedConfig(): Promise<void> {
    try {
      const d = await this.db.getConfig("minDiscountPercent");
      if (d) filterConfig.minDiscountPercent = parseFloat(d);
      const p = await this.db.getConfig("maxPriceBRL");
      if (p) filterConfig.maxPriceBRL = parseFloat(p);
    } catch { logger.warn("[ML] Sem configurações salvas."); }
  }
}