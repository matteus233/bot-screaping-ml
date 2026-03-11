// src/api/mlClient.ts — Cliente da API Mercado Livre
import axios, { type AxiosInstance } from "axios";
import { config } from "../config.ts";
import { tokenManager } from "./tokenManager.ts";
import { logger } from "../utils/logger.ts";
import { ML_CATEGORIES } from "../types/index.ts";
import type { MLProduct, MLSearchResponse, MLReviewsResponse } from "../types/index.js";

const MAX_RETRIES  = 3;
const RETRY_DELAY  = 2000;
const PAGE_SIZE    = 50;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export class MLClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.ml.baseUrl,
      timeout: 15_000,
    });

    // Injeta o Authorization em toda requisição de forma transparente
    this.http.interceptors.request.use(async (req) => {
      const token = await tokenManager.getAccessToken();
      req.headers.Authorization = `Bearer ${token}`;
      return req;
    });
  }

  // ──────────────────────────────────────────────
  //  Helper com retry
  // ──────────────────────────────────────────────
  private async get<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { data } = await this.http.get<T>(endpoint, { params });
        return data;
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : null;

        // 401 = token expirado (o interceptor cuida do refresh, mas pode falhar)
        if (status === 401) {
          logger.warn("401 recebido. Verificar tokens OAuth.");
          return null;
        }

        // 429 = rate limit
        if (status === 429) {
          const wait = 60_000;
          logger.warn(`Rate limit ML. Aguardando ${wait / 1000}s...`);
          await sleep(wait);
          continue;
        }

        logger.error(`ML API tentativa ${attempt}/${MAX_RETRIES} [${endpoint}]: ${err}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY * attempt);
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────
  //  Busca por promoções / descontos
  // ──────────────────────────────────────────────

  async searchDeals(options: {
    categoryId?: string;
    keyword?: string;
    offset?: number;
    limit?: number;
  }): Promise<MLProduct[]> {
    const { categoryId, keyword, offset = 0, limit = PAGE_SIZE } = options;

    const params: Record<string, unknown> = {
      site_id:      "MLB",
      sort:         "relevance",
      offset,
      limit,
      // Filtra apenas itens com desconto ativo
      promotions:   "price_discount",
    };

    if (categoryId) params.category = categoryId;
    if (keyword)    params.q        = keyword;

    const data = await this.get<MLSearchResponse>("/sites/MLB/search", params);
    return data?.results ?? [];
  }

  /** Busca itens em liquidação (MLB Lightning Deals). */
  async getLightningDeals(offset = 0): Promise<MLProduct[]> {
    const data = await this.get<MLSearchResponse>("/sites/MLB/search", {
      site_id:    "MLB",
      sort:       "relevance",
      promotions: "lightning_deal",
      offset,
      limit:      PAGE_SIZE,
    });
    return data?.results ?? [];
  }

  /** Avaliação de um item (endpoint separado na ML). */
  async getReviews(itemId: string): Promise<MLReviewsResponse | null> {
    return this.get<MLReviewsResponse>(`/reviews/item/${itemId}`);
  }

  /** Enriquece o produto com nota de avaliação. */
  async enrichWithRating(product: MLProduct): Promise<MLProduct> {
    const review = await this.getReviews(product.id);
    if (review) {
      product.rating_average = review.rating_average;
      product.rating_total   = review.total;
    }
    return product;
  }

  /**
   * Varre categorias/páginas e retorna lista de produtos únicos com desconto.
   * Enriquece avaliações em lote.
   */
  async fetchAllDeals(options: {
    categoryKey?: string;
    keyword?: string;
    maxPages?: number;
    includeLightning?: boolean;
  }): Promise<MLProduct[]> {
    const { categoryKey = "todas", keyword, maxPages = 4, includeLightning = true } = options;
    const categoryId = ML_CATEGORIES[categoryKey] || undefined;

    const all: MLProduct[] = [];
    const seen = new Set<string>();

    const addUnique = (items: MLProduct[]) => {
      for (const item of items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          all.push(item);
        }
      }
    };

    // Busca deals com desconto por página
    for (let page = 0; page < maxPages; page++) {
      const items = await this.searchDeals({
        categoryId,
        keyword,
        offset: page * PAGE_SIZE,
      });
      if (!items.length) break;
      addUnique(items);
      logger.info(`ML deals página ${page + 1}: ${items.length} itens`);
    }

    // Lightning deals (se habilitado)
    if (includeLightning) {
      const lightning = await this.getLightningDeals();
      addUnique(lightning);
      logger.info(`ML lightning deals: ${lightning.length} itens`);
    }

    // Calcula desconto percentual e enriquece com avaliações em paralelo (lotes de 10)
    await this.batchEnrich(all);

    logger.info(`Total ML único: ${all.length} produtos`);
    return all;
  }

  private async batchEnrich(products: MLProduct[], batchSize = 10): Promise<void> {
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      await Promise.all(batch.map((p) => this.enrichWithRating(p)));
    }
  }
}