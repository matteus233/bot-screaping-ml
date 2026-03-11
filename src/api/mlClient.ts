// src/api/mlClient.ts — Cliente da API Mercado Livre
import axios, { type AxiosInstance } from "axios";
import { tokenManager } from "./tokenManager.ts";
import { logger } from "../utils/logger.ts";
import { ML_CATEGORIES } from "../types/index.ts";
import type { MLProduct, MLSearchResponse, MLReviewsResponse } from "../types/index.ts";

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const PAGE_SIZE   = 50;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export class MLClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: "https://api.mercadolibre.com",   // fixo — não depende do config
      timeout: 15_000,
    });

    this.http.interceptors.request.use(async (req) => {
      const token = await tokenManager.getAccessToken();
      req.headers.Authorization = `Bearer ${token}`;
      return req;
    });
  }

  // ──────────────────────────────────────────────
  //  Helper com retry e log detalhado
  // ──────────────────────────────────────────────

  private async get<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { data } = await this.http.get<T>(endpoint, { params });
        return data;
      } catch (err: unknown) {
        if (!axios.isAxiosError(err)) {
          logger.error("[MLClient] Erro inesperado:", err);
          break;
        }

        const status = err.response?.status;
        const detail = JSON.stringify(err.response?.data ?? err.message);

        if (status === 401) {
          logger.warn(`[MLClient] 401 em ${endpoint}`);
          logger.warn(`[MLClient] Detalhe: ${detail}`);
          return null;
        }
        if (status === 403) {
          logger.warn(`[MLClient] 403 em ${endpoint} — sem permissão`);
          return null;
        }
        if (status === 429) {
          logger.warn("[MLClient] Rate limit. Aguardando 60s...");
          await sleep(60_000);
          continue;
        }

        logger.error(`[MLClient] tentativa ${attempt}/${MAX_RETRIES} status=${status}: ${detail}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY * attempt);
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────
  //  Busca por categoria
  //  NOTA: o param "promotions" NAO existe na API
  //  publica do ML — filtro de desconto e client-side
  // ──────────────────────────────────────────────

  async searchItems(options: {
    categoryId?: string;
    keyword?:    string;
    offset?:     number;
    limit?:      number;
    sort?:       string;
  }): Promise<MLProduct[]> {
    const { categoryId, keyword, offset = 0, limit = PAGE_SIZE, sort = "relevance" } = options;

    const params: Record<string, unknown> = { offset, limit, sort };
    if (categoryId) params.category = categoryId;
    if (keyword)    params.q        = keyword;

    const data = await this.get<MLSearchResponse>("/sites/MLB/search", params);
    if (!data) return [];

    logger.debug(
      `[MLClient] category=${categoryId ?? "todas"} offset=${offset} total=${data.paging.total} recebidos=${data.results.length}`,
    );

    // Filtra client-side: so produtos com desconto real
    const comDesconto = data.results.filter(
      (p) => p.original_price !== null && p.original_price > p.price,
    );
    logger.debug(`[MLClient] Com desconto: ${comDesconto.length}/${data.results.length}`);
    return comDesconto;
  }

  // ──────────────────────────────────────────────
  //  Avaliacoes (endpoint separado)
  // ──────────────────────────────────────────────

  async getReviews(itemId: string): Promise<MLReviewsResponse | null> {
    return this.get<MLReviewsResponse>(`/reviews/item/${itemId}`);
  }

  async enrichWithRating(product: MLProduct): Promise<MLProduct> {
    const review = await this.getReviews(product.id);
    if (review) {
      product.rating_average = review.rating_average;
      product.rating_total   = review.total;
    }
    return product;
  }

  // ──────────────────────────────────────────────
  //  Busca principal — varre paginas de uma categoria
  // ──────────────────────────────────────────────

  async fetchAllDeals(options: {
    categoryKey?: string;
    keyword?:     string;
    maxPages?:    number;
  }): Promise<MLProduct[]> {
    const { categoryKey = "todas", keyword, maxPages = 4 } = options;
    const categoryId = ML_CATEGORIES[categoryKey] || undefined;

    const all: MLProduct[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages; page++) {
      const items = await this.searchItems({ categoryId, keyword, offset: page * PAGE_SIZE });

      let novos = 0;
      for (const item of items) {
        if (!seen.has(item.id)) { seen.add(item.id); all.push(item); novos++; }
      }

      logger.info(`[ML] ${categoryKey} p.${page + 1}: ${items.length} com desconto, ${novos} novos`);

      if (items.length < PAGE_SIZE / 2) break;
    }

    await this.batchEnrich(all);
    return all;
  }

  private async batchEnrich(products: MLProduct[], batchSize = 10): Promise<void> {
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      await Promise.all(batch.map((p) => this.enrichWithRating(p)));
    }
  }
}