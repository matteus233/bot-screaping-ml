// src/filters/productFilter.ts — Filtros independentes para Mercado Livre
import { filterConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { DatabaseManager } from "../database/dbManager.ts";
import type { MLProduct, FilterResult } from "../types/index.ts";

type Check = (p: MLProduct) => FilterResult | Promise<FilterResult>;

export class ProductFilter {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async isValid(product: MLProduct): Promise<FilterResult> {
    const checks: Check[] = [
      this.checkDiscount.bind(this),
      this.checkPrice.bind(this),
      this.checkCondition.bind(this),
      this.checkRating.bind(this),
      this.checkSales.bind(this),
      this.checkKeywords.bind(this),
      this.checkCategory.bind(this),
      this.checkHistoricalPrice.bind(this),
    ];

    for (const check of checks) {
      const result = await check(product);
      if (!result.passed) return result;
    }
    return { passed: true, reason: "" };
  }

  async filterProducts(products: MLProduct[]): Promise<MLProduct[]> {
    const results = await Promise.all(
      products.map(async (p) => ({ product: p, result: await this.isValid(p) })),
    );

    const valid = results.filter(({ result }) => result.passed).map(({ product }) => product);
    results
      .filter(({ result }) => !result.passed)
      .forEach(({ product, result }) =>
        logger.debug(`Rejeitado [${product.title?.slice(0, 40)}]: ${result.reason}`),
      );

    logger.info(`Filtro ML: ${valid.length}/${products.length} aprovados`);
    return valid;
  }

  // ──────────────────────────────────────────────
  //  Verificações individuais
  // ──────────────────────────────────────────────

  private checkDiscount(p: MLProduct): FilterResult {
    const original = p.original_price ?? 0;
    const current  = p.price;

    if (original <= 0 || current <= 0) {
      if (filterConfig.minDiscountPercent <= 0) {
        return { passed: true, reason: "" };
      }
      return { passed: false, reason: "preço inválido ou sem desconto registrado" };
    }

    const pct = ((original - current) / original) * 100;
    p._discountPct = Math.round(pct * 10) / 10;

    if (pct < filterConfig.minDiscountPercent) {
      return { passed: false, reason: `desconto ${pct.toFixed(1)}% < mínimo ${filterConfig.minDiscountPercent}%` };
    }
    return { passed: true, reason: "" };
  }

  private checkPrice(p: MLProduct): FilterResult {
    const price = p.price;
    if (price < filterConfig.minPriceBRL) {
      return { passed: false, reason: `R$${price} abaixo do mínimo R$${filterConfig.minPriceBRL}` };
    }
    if (price > filterConfig.maxPriceBRL) {
      return { passed: false, reason: `R$${price} acima do máximo R$${filterConfig.maxPriceBRL}` };
    }
    return { passed: true, reason: "" };
  }

  private checkCondition(p: MLProduct): FilterResult {
    if (filterConfig.onlyNewCondition && p.condition !== "new") {
      return { passed: false, reason: "produto usado (filtro: somente novo)" };
    }
    return { passed: true, reason: "" };
  }

  private checkRating(p: MLProduct): FilterResult {
    // Rating é opcional — só filtra se vier preenchido
    if (p.rating_average !== undefined && p.rating_average < filterConfig.minRating) {
      return { passed: false, reason: `rating ${p.rating_average} < mínimo ${filterConfig.minRating}` };
    }
    if (p.rating_total !== undefined && p.rating_total < filterConfig.minRatingCount) {
      return { passed: false, reason: `${p.rating_total} avaliações < mínimo ${filterConfig.minRatingCount}` };
    }
    return { passed: true, reason: "" };
  }

  private checkSales(p: MLProduct): FilterResult {
    if (p.sold_quantity < filterConfig.minSoldQuantity) {
      return { passed: false, reason: `${p.sold_quantity} vendas < mínimo ${filterConfig.minSoldQuantity}` };
    }
    return { passed: true, reason: "" };
  }

  private checkKeywords(p: MLProduct): FilterResult {
    const title = (p.title ?? "").toLowerCase();

    for (const kw of filterConfig.keywordsBlacklist) {
      if (title.includes(kw.toLowerCase())) {
        return { passed: false, reason: `blacklist: '${kw}'` };
      }
    }
    if (
      filterConfig.keywordsWhitelist.length > 0 &&
      !filterConfig.keywordsWhitelist.some((kw) => title.includes(kw.toLowerCase()))
    ) {
      return { passed: false, reason: "nenhuma keyword da whitelist" };
    }
    return { passed: true, reason: "" };
  }

  private checkCategory(p: MLProduct): FilterResult {
    if (filterConfig.allowedCategories.length === 0) return { passed: true, reason: "" };
    if (!filterConfig.allowedCategories.includes(p.category_id)) {
      return { passed: false, reason: `categoria ${p.category_id} não permitida` };
    }
    return { passed: true, reason: "" };
  }

  private async checkHistoricalPrice(p: MLProduct): Promise<FilterResult> {
    if (!filterConfig.historicalPriceCheck) return { passed: true, reason: "" };

    const itemId  = p.id;
    const shopId  = String(p.seller_id);
    const current = p.price;

    await this.db.recordPrice(itemId, shopId, current);

    const histMin = await this.db.getHistoricalMinPrice(itemId, shopId);
    if (histMin === null) return { passed: true, reason: "" };

    const threshold = histMin * filterConfig.maxPriceVsHistorical;
    if (current > threshold) {
      return {
        passed: false,
        reason: `R$${current.toFixed(2)} > ${(filterConfig.maxPriceVsHistorical * 100).toFixed(0)}% do mín histórico R$${histMin.toFixed(2)}`,
      };
    }

    p._historicalMin = histMin;
    return { passed: true, reason: "" };
  }
}
