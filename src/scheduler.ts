// src/scheduler.ts - Orquestrador ML (Telegram only)
import cron from "node-cron";
import { config, filterConfig } from "./config.ts";
import { MLClient } from "./api/mlClient.ts";
import { ProductFilter } from "./filters/productFilter.ts";
import { DatabaseManager } from "./database/dbManager.ts";
import { TelegramNotifier } from "./notifiers/telegramNotifier.ts";
import { logger } from "./utils/logger.ts";
import { ML_CATEGORIES } from "./types/index.ts";
import type { MLProduct } from "./types/index.ts";

const SEND_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getDailyRange(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

function formatDateKey(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isEventDay(now: Date, eventDays: string[]): boolean {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const key = `${yyyy}-${mm}-${dd}`;
  return eventDays.includes(key);
}

function isQuietHours(now: Date): boolean {
  const q = config.marketing.quietHours;
  if (!q.enabled) return false;
  if (q.allowOnEventDays && isEventDay(now, config.marketing.eventDays)) {
    return false;
  }
  const h = now.getHours();
  const start = q.startHour;
  const end = q.endHour;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function getCyclesLeft(now: Date, intervalMinutes: number): number {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const diffMs = end.getTime() - now.getTime();
  const minutesLeft = Math.max(0, Math.floor(diffMs / 60000));
  return Math.max(1, Math.ceil(minutesLeft / intervalMinutes));
}

function computeDiscountPct(p: MLProduct): number | null {
  if (p._discountPct !== undefined) return p._discountPct;
  if (p.original_price && p.original_price > 0) {
    return ((p.original_price - p.price) / p.original_price) * 100;
  }
  if (p.discount_percentage) return p.discount_percentage;
  return null;
}

function computeScore(p: MLProduct): number {
  const discount = computeDiscountPct(p) ?? 0;
  const rating = p.rating_average ?? 0;
  const sales = p.sold_quantity ?? 0;
  const price = p.price ?? 0;
  const priceScore = price > 0 ? Math.max(0, 30 - Math.log10(price) * 10) : 0;
  const salesScore = Math.log10(sales + 1) * 10;
  const title = (p.title ?? "").toLowerCase();
  const preferred = config.marketing.preferredKeywords ?? [];
  let preferredScore = 0;
  for (const kw of preferred) {
    if (!kw) continue;
    if (title.includes(kw.toLowerCase())) {
      preferredScore += 30;
    }
  }
  const offerTags = p._offerTags ?? [];
  const preferredTags = config.marketing.preferredOfferTags ?? [];
  let offerScore = 0;
  for (const tag of preferredTags) {
    if (offerTags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      // prioridade decrescente conforme a ordem da lista
      offerScore = Math.max(offerScore, 60 - preferredTags.indexOf(tag) * 10);
    }
  }
  return discount * 2 + rating * 5 + salesScore + priceScore + preferredScore + offerScore;
}

function deduplicateById(products: MLProduct[]): MLProduct[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    const key = `${p.id}:${p.seller_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class MLBot {
  private readonly db: DatabaseManager;
  private readonly api: MLClient;
  private readonly filter: ProductFilter;
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
    if (this.running) { logger.warn("Ciclo ML em execucao. Pulando."); return; }
    this.running = true;
    logger.info("[ML] Iniciando ciclo...");

    try {
      const testCategoriesEnv = process.env.ML_TEST_CATEGORIES || "";
      const testKeywordsEnv = process.env.ML_TEST_KEYWORDS || "";
      const testOfferPagesEnv = process.env.ML_TEST_OFFER_PAGES || "";
      const offerPagesEnv = process.env.ML_OFFER_PAGES || "";

      const testCategories = testCategoriesEnv
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .filter((v) => v in ML_CATEGORIES);

      const testKeywords = testKeywordsEnv
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

      const testOfferPages = testOfferPagesEnv
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

      const offerPages = offerPagesEnv
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

      const categories = testCategories.length > 0
        ? testCategories
        : filterConfig.allowedCategories.length > 0
          ? filterConfig.allowedCategories
          : Object.keys(ML_CATEGORIES).filter((k) => k !== "todas");

      const now = new Date();
      const quiet = isQuietHours(now);
      await this.maybeSendCoupons(now, quiet);
      if (quiet) {
        logger.info("[ML] Fora do horario permitido para envio no canal. Alertas seguem ativos.");
      }

      const cleaned = await this.db.cleanupSentOlderThan(90);
      if (cleaned > 0) {
        logger.info(`[ML] Limpeza: removidos ${cleaned} envios antigos (>90 dias).`);
      }

      const all: MLProduct[] = [];
      const seen = new Set<string>();

      const fast = process.env.ML_TEST_FAST === "true";
      const maxPages = fast ? 1 : 3;
      if (testOfferPages.length > 0) {
        logger.info(`[ML] Teste por paginas de oferta: ${testOfferPages.join(", ")}`);
        for (const pageUrl of testOfferPages) {
          const items = await this.api.fetchAllDeals({
            categoryKey: "todas",
            maxPages,
            directUrl: pageUrl,
          });
          for (const item of items) {
            if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
          }
        }
      } else if (offerPages.length > 0) {
        logger.info(`[ML] Paginas de oferta fixas: ${offerPages.join(", ")}`);
        for (const pageUrl of offerPages) {
          const items = await this.api.fetchAllDeals({
            categoryKey: "todas",
            maxPages,
            directUrl: pageUrl,
          });
          for (const item of items) {
            if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
          }
        }
      } else if (testKeywords.length > 0) {
        logger.info(`[ML] Teste por palavras-chave: ${testKeywords.join(", ")}`);
        for (const keyword of testKeywords) {
          const items = await this.api.fetchAllDeals({ keyword, categoryKey: "todas", maxPages });
          for (const item of items) {
            if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
          }
        }
      } else {
        for (const cat of categories) {
          const items = await this.api.fetchAllDeals({ categoryKey: cat, maxPages });
          for (const item of items) {
            if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
          }
        }
      }

      const unique = deduplicateById(all);
      logger.info(`[ML] Total unico: ${unique.length}`);

      const valid = await this.filter.filterProducts(unique);

      const recentSent = await this.db.getRecentSentKeys("telegram", 24);
      const unsent = valid.filter((p) => !recentSent.has(`${p.id}:${p.seller_id}`));
      if (recentSent.size > 0) {
        logger.info(`[ML] Ignorando ja enviados (24h): ${recentSent.size}`);
      }
      logger.info(`[ML] Disponiveis para selecao: ${unsent.length} produtos`);

      const daily = getDailyRange(now);
      const sentToday = await this.db.countSentBetween("telegram", daily.start, daily.end);
      const remainingDay = Math.max(0, config.marketing.maxPerDay - sentToday);
      if (remainingDay <= 0) {
        logger.info("[ML] Limite diario atingido. Nenhum envio neste ciclo.");
        return;
      }

      const cyclesLeft = getCyclesLeft(now, config.rateLimit.fetchIntervalMinutes);
      const targetPerCycle = Math.max(1, Math.ceil(remainingDay / cyclesLeft));
      let cap = Math.min(config.marketing.maxPerCycle, targetPerCycle, remainingDay);

      const testLimitRaw = Number(process.env.ML_TEST_LIMIT ?? "");
      const testLimit = Number.isFinite(testLimitRaw) && testLimitRaw > 0 ? testLimitRaw : 5;
      if (fast) cap = Math.min(cap, testLimit);

      const qualified = unsent
        .map((p) => ({ p, score: computeScore(p), discount: computeDiscountPct(p) }))
        .filter((x) => x.discount === null || x.discount >= config.marketing.minDiscountToSend)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p);

      const selected = qualified.slice(0, cap);
      if (selected.length === 0) {
        logger.info("[ML] Nenhum produto qualificado para envio neste ciclo.");
        return;
      }

      let sent = 0;
      for (const product of selected) {
        const affiliateUrl = this.api.buildAffiliateUrl(product.permalink, product.id);
        product._affiliateUrl = affiliateUrl;

        const ok = config.telegram.enabled && !quiet
          ? await this.telegram.sendProduct(product, affiliateUrl)
          : false;

        if (config.telegram.enabled) {
          await this.telegram.notifyAlerts(product, affiliateUrl);
        }

        if (ok) { sent++; await sleep(SEND_DELAY_MS); }
      }

      logger.info(`[ML] Ciclo concluido: ${sent} enviados.`);
    } catch (err) {
      logger.error("[ML] Erro no ciclo:", err);
    } finally {
      this.running = false;
    }
  }

  async start(): Promise<void> {
    logger.info("ML Promo Bot iniciando...");

    await this.db.initialize();
    await this.loadSavedConfig();

    this.telegram.startPolling();

    await this.runCycle();

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
    this.api.close()
      .catch((err) => logger.warn("[ML] Erro ao fechar scraper:", err))
      .finally(() => this.db.close().finally(() => process.exit(0)));
  }

  private async loadSavedConfig(): Promise<void> {
    if (process.env.ML_IGNORE_DB_CONFIG === "true") {
      logger.info("[ML] Ignorando configuracoes salvas (ML_IGNORE_DB_CONFIG=true).");
      return;
    }
    try {
      const d = await this.db.getConfig("minDiscountPercent");
      if (d) filterConfig.minDiscountPercent = parseFloat(d);
      const p = await this.db.getConfig("maxPriceBRL");
      if (p) filterConfig.maxPriceBRL = parseFloat(p);
    } catch { logger.warn("[ML] Sem configuracoes salvas."); }
  }

  private async maybeSendCoupons(now: Date, quiet: boolean): Promise<void> {
    if (quiet || !config.telegram.enabled) return;

    const schedule = [
      { h: 9, m: 0 },
      { h: 18, m: 30 },
    ];
    const hour = now.getHours();
    const minute = now.getMinutes();
    const target = schedule.find((t) => t.h === hour && t.m === minute);
    if (!target) return;

    const dateKey = formatDateKey(now);
    const key = `ml_coupon_last_${target.h}_${target.m}`;
    const last = await this.db.getConfig(key, "");
    if (last === dateKey) return;

    const sent = await this.telegram.sendCouponsToChannel();
    logger.info(`[ML] Cupons enviados automaticamente: ${sent}`);
    await this.db.setConfig(key, dateKey);
  }
}
