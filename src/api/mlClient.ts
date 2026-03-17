// src/api/mlClient.ts - Scraper Mercado Livre (JSON da pagina + fallback HTML)
import { logger } from "../utils/logger.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ML_CATEGORIES } from "../types/index.ts";
import type { MLProduct, MLReviewsResponse } from "../types/index.ts";
import { config } from "../config.ts";

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;
const SCRAPER_PROFILE_DIR = ".ml-playwright-profile";

type SearchOptions = {
  categoryId?: string;
  keyword?: string;
  offset?: number;
  directUrl?: string;
  forceOfferTag?: string;
};

type DealOptions = {
  categoryKey?: string;
  keyword?: string;
  maxPages?: number;
  directUrl?: string;
  forceOfferTag?: string;
};

function parseBRL(value: string | null | undefined): number | null {
  if (!value) return null;
  const digits = value.replace(/[^\d,\.]/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(digits);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseSold(text: string): number {
  const match = text.match(/([\d\.]+)\s+vendid/i);
  if (!match) return 0;
  return Number(match[1].replace(/\./g, "")) || 0;
}

type BrowserContext = {
  pages(): Page[];
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

type Page = {
  url(): string;
  goto(url: string, opts?: { waitUntil?: string }): Promise<void>;
  waitForURL(predicate: (url: URL) => boolean, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  $$eval<T>(selector: string, fn: (cards: Element[]) => T): Promise<T>;
  evaluate<T>(fn: () => T): Promise<T>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
  setDefaultTimeout(ms: number): void;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<void>;
};

export class MLClient {
  private context: BrowserContext | null = null;
  private warmedUp = false;

  private async loadPlaywrightChromium(): Promise<{ launchPersistentContext: Function }> {
    try {
      const playwright = await import("playwright");
      return playwright.chromium as { launchPersistentContext: Function };
    } catch {
      throw new Error(
        'Playwright nao encontrado. Instale com "npm i playwright" e rode "npx playwright install chromium".',
      );
    }
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    const headless = process.env.ML_SCRAPER_HEADLESS !== "false";
    const chromium = await this.loadPlaywrightChromium();
    const useChromeChannel = process.env.ML_SCRAPER_CHANNEL === "chrome";

    this.context = await chromium.launchPersistentContext(SCRAPER_PROFILE_DIR, {
      headless,
      channel: useChromeChannel ? "chrome" : undefined,
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      viewport: { width: 1366, height: 768 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--lang=pt-BR,pt",
        "--disable-dev-shm-usage",
      ],
    });

    logger.info(`[Scraper] Browser iniciado (headless=${headless}).`);
    return this.context!;
  }

  private async getPage(): Promise<Page> {
    const context = await this.getContext();
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(25_000);
    return page;
  }

  private async ensureWarmup(page: Page): Promise<void> {
    if (this.warmedUp) return;
    this.warmedUp = true;

    try {
      await page.goto("https://lista.mercadolivre.com.br", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
    } catch (err) {
      logger.warn("[Scraper] Warmup falhou (seguindo mesmo assim).", err);
    }
  }

  private async safeGoto(page: Page, url: string): Promise<Page> {
    const delays = [500, 1500, 3000];
    let lastErr: unknown;

    for (const delay of delays) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return page;
      } catch (err) {
        lastErr = err;
        logger.warn(`[Scraper] Falha ao navegar (retry em ${delay}ms): ${String(err)}`);
        await page.waitForTimeout(delay);
      }
    }

    logger.warn(`[Scraper] Falha ao navegar (tentando nova aba): ${String(lastErr)}`);
    const context = await this.getContext();
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(25_000);
    await fresh.goto(url, { waitUntil: "domcontentloaded" });
    return fresh;
  }

  private async ensureLoginIfRequired(page: Page): Promise<void> {
    if (!page.url().includes("/login")) return;

    logger.warn("[Scraper] Login necessario no Mercado Livre. Complete no browser aberto.");
    await page.waitForURL((url: URL) => !url.toString().includes("/login"), { timeout: 180_000 });
    logger.info("[Scraper] Login detectado com sucesso.");
  }

  private buildSearchUrl(options: SearchOptions): string {
    const { categoryId, keyword, offset = 0, directUrl } = options;
    if (directUrl) return directUrl;
    const from = offset + 1;
    const onlyOffers = process.env.ML_ONLY_OFFERS === "true";

    const query = keyword?.trim();
    const basePath = query
      ? `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}${onlyOffers ? "_Discount_5-100" : ""}`
      : categoryId
        ? `https://lista.mercadolivre.com.br/c/${encodeURIComponent(categoryId)}${onlyOffers ? "_Discount_5-100" : ""}`
        : "https://lista.mercadolivre.com.br";

    const url = new URL(basePath);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/_Desde_${from}_NoIndex_True`;

    if (categoryId && query) {
      url.searchParams.set("category", categoryId);
    }

    return url.toString();
  }

  async searchItems(options: SearchOptions): Promise<MLProduct[]> {
    const page = await this.getPage();
    const url = this.buildSearchUrl(options);
    const onlyOffers = process.env.ML_ONLY_OFFERS === "true";
    const inferredTag = inferOfferTagFromUrl(url);
    const forceOfferTag =
      options.forceOfferTag ??
      (onlyOffers && /discount/i.test(url) ? "Desconto" : inferredTag);

    await this.ensureWarmup(page);

    const networkPayloads: Array<{ url: string; data: any }> = [];
    const onResponse = async (response: any) => {
      try {
        const url = response.url?.() ?? "";
        const headers = response.headers?.() ?? {};
        const contentType = String(headers["content-type"] ?? "");
        if (!contentType.includes("application/json")) return;
        const data = await response.json();
        const results = extractResultsFromState(data);
        if (data && results.length > 0) {
          networkPayloads.push({ url, data });
        }
      } catch {
        // ignore noisy responses
      }
    };

    page.on("response", onResponse);
    const navPage = await this.safeGoto(page, url);
    await this.ensureLoginIfRequired(navPage);
    const extraWait = url.includes("/ofertas") ? 6000 : 2000;
    await navPage.waitForTimeout(extraWait);
    navPage.removeListener("response", onResponse);

    const blockCheck = await navPage.$$eval("body", (nodes: Element[]) => {
      const body = nodes[0];
      const title = document.title || "";
      const text = (body?.textContent || "").slice(0, 5000);
      return { title, text };
    });
    const isBlocked =
      /captcha|robo|robot|acesso negado|blocked|forbidden/i.test(blockCheck.title) ||
      /captcha|robo|robot|acesso negado|blocked|forbidden/i.test(blockCheck.text);
    if (isBlocked) {
      logger.warn(`[Scraper] Possivel bloqueio/anti-bot. Titulo: "${blockCheck.title}"`);
    }

    // JSON-first: tenta extrair do estado pre-carregado da pagina
    const jsonProducts = await this.extractProductsFromPage(navPage, options, forceOfferTag);
    if (jsonProducts.length > 0) {
      logger.info(`[Scraper] JSON OK: ${jsonProducts.length} itens`);
      return jsonProducts;
    }

    const networkProducts = this.extractProductsFromNetwork(networkPayloads, options, forceOfferTag);
    if (networkProducts.length > 0) {
      logger.info(`[Scraper] JSON (network) OK: ${networkProducts.length} itens`);
      return networkProducts;
    }

    const jsonLdProducts = await this.extractProductsFromJsonLd(navPage, options, forceOfferTag);
    if (jsonLdProducts.length > 0) {
      logger.info(`[Scraper] JSON-LD OK: ${jsonLdProducts.length} itens`);
      return jsonLdProducts;
    }

    const cardSelector =
      "li.ui-search-layout__item, div.ui-search-result__content, div.ui-search-result__wrapper, div.ui-search-result";

    try {
      await navPage.waitForSelector(cardSelector, { timeout: 5000 });
    } catch {
      // ignore
    }

    if (isBlocked) {
      logger.warn("[Scraper] Aguardando resolver bloqueio/login (ate 3 min)...");
      try {
        await navPage.waitForSelector(cardSelector, { timeout: 180_000 });
      } catch {
        // still blocked or no results
      }
      await this.ensureLoginIfRequired(navPage);
    }

    const cardCount = await navPage.$$eval(cardSelector, (cards: Element[]) => cards.length);
    logger.info(`[Scraper] cardCount=${cardCount} url=${navPage.url()}`);
    if (cardCount === 0) {
      const title = await navPage.title().catch(() => "");
      const bodySnippet = await navPage.$$eval("body", (nodes: Element[]) => {
        const body = nodes[0];
        const text = (body?.textContent || "").replace(/\s+/g, " ").trim();
        return text.slice(0, 400);
      });
      try {
        const html = await navPage.content();
        const logsDir = path.join(process.cwd(), "logs");
        mkdirSync(logsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = path.join(logsDir, `ml-debug-${stamp}.html`);
        writeFileSync(outPath, html, "utf8");
        logger.warn(`[Scraper] HTML salvo para debug: ${outPath}`);
        await this.saveDebugState(navPage, stamp, "no-cards");
        const imgPath = path.join(logsDir, `ml-debug-${stamp}.png`);
        await navPage.screenshot({ path: imgPath, fullPage: true });
        logger.warn(`[Scraper] Screenshot salvo para debug: ${imgPath}`);
      } catch (err) {
        logger.warn("[Scraper] Falha ao salvar debug (HTML/screenshot).", err);
      }
      logger.warn(
        `[Scraper] Nenhum card encontrado. url=${navPage.url()} title="${title}" snippet="${bodySnippet}"`,
      );
      return [];
    }

    const products = await navPage.$$eval(cardSelector, (cards: Element[]) => {
      return cards
        .map((card: Element, index: number) => {
          const title =
            card.querySelector("h3.poly-component__title")?.textContent?.trim() ||
            card.querySelector("h2.ui-search-item__title")?.textContent?.trim() ||
            card.querySelector(".ui-search-item__title")?.textContent?.trim() ||
            card.querySelector("h2")?.textContent?.trim() ||
            "";

          const link =
            (card.querySelector("a.poly-component__title") as HTMLAnchorElement | null)?.href ||
            (card.querySelector("a.ui-search-link") as HTMLAnchorElement | null)?.href ||
            (card.querySelector("a.ui-search-item__group__element") as HTMLAnchorElement | null)
              ?.href ||
            (card.querySelector("a") as HTMLAnchorElement | null)?.href ||
            "";

          const currentFraction =
            card.querySelector(".andes-money-amount__fraction")?.textContent?.trim() || "";
          const currentCents =
            card.querySelector(".andes-money-amount__cents")?.textContent?.trim() || "";
          const currentText = currentCents ? `${currentFraction},${currentCents}` : currentFraction;

          const originalFraction =
            card
              .querySelector(".ui-search-price__original-value .andes-money-amount__fraction")
              ?.textContent?.trim() || "";
          const originalCents =
            card
              .querySelector(".ui-search-price__original-value .andes-money-amount__cents")
              ?.textContent?.trim() || "";
          const originalText = originalCents ? `${originalFraction},${originalCents}` : originalFraction;

          const priceMeta =
            (card.querySelector("[itemprop='price']") as HTMLMetaElement | null)?.content || "";

          const metaText = card.textContent || "";
          const image =
            (card.querySelector("img") as HTMLImageElement | null)?.src ||
            (card.querySelector("img") as HTMLImageElement | null)?.getAttribute("data-src") ||
            "";
          const promoCandidates = Array.from(
            card.querySelectorAll(
              "[class*='badge'], [class*='coupon'], [class*='promo'], .ui-search-discount, .ui-search-item__highlight-label, .poly-coupons__pill",
            ),
          )
            .map((n) => (n as HTMLElement).innerText?.trim() || "")
            .filter(Boolean);

          const promoTags: string[] = [];
          const normalizedMeta = metaText
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
          const text = normalizedMeta.toLowerCase();
          if (/oferta relampago/.test(text)) promoTags.push("Oferta relampago");
          if (/oferta do dia/.test(text)) promoTags.push("Oferta do dia");
          if (/preco imperdivel|imperdivel/.test(text)) promoTags.push("Preco imperdivel");
          if (/super oferta|superoferta/.test(text)) promoTags.push("Super oferta");
          if (/oferta/.test(text) && promoTags.length === 0) promoTags.push("Oferta");
          for (const c of promoCandidates) {
            if (!promoTags.includes(c)) promoTags.push(c);
          }
          const freeShipping = /frete gratis/i.test(normalizedMeta);
          const soldTextMatch = metaText.match(/\+?[\d\.]+\s+vendid[oa]s?/i)?.[0] || "";
          const isNew = /\bnovo\b/i.test(metaText);

          const idMatch = link.match(/MLB-?\d+|MLBU\d+/i);
          return {
            id: idMatch?.[0] || link || `${title}-${index}`,
            title,
            permalink: link,
            thumbnail: image || "",
            currentText: currentText || priceMeta,
            originalText,
            freeShipping,
            soldText: soldTextMatch,
            condition: isNew ? "new" : "used",
            promoTags,
          };
        })
        .filter(
          (item: { title: string; permalink: string; currentText: string }) =>
            item.title && item.permalink && item.currentText,
        );
    });

    const parsed = products
      .map((p: {
        id: string;
        title: string;
        permalink: string;
        thumbnail: string;
        currentText: string;
        originalText: string;
        freeShipping: boolean;
        soldText: string;
        condition: string;
        promoTags?: string[];
      }) => {
        const price = parseBRL(p.currentText);
        const original = parseBRL(p.originalText);

        if (!price) return null;

        const result: MLProduct = {
          id: p.id,
          site_id: "MLB",
          category_id: options.categoryId || "SCRAPED",
          seller_id: 0,
          title: p.title,
          condition: p.condition === "new" ? "new" : "used",
          thumbnail: p.thumbnail,
          permalink: p.permalink,
          price,
          original_price: original ?? null,
          currency_id: "BRL",
          available_quantity: 0,
          sold_quantity: parseSold(p.soldText),
          buying_mode: "buy_it_now",
          shipping: {
            free_shipping: p.freeShipping,
            store_pick_up: false,
            mode: "not_specified",
            logistic_type: "not_specified",
          },
          seller: { id: 0, nickname: "desconhecido" },
        };
        if (p.promoTags && p.promoTags.length > 0) result._offerTags = p.promoTags;
        applyForceOfferTag(result, forceOfferTag);
        if (!allowProductByOfferFlag(result, forceOfferTag)) return null;

        return result;
      })
      .filter((item: MLProduct | null): item is MLProduct => Boolean(item));

    if (parsed.length === 0) {
      try {
        const html = await navPage.content();
        const logsDir = path.join(process.cwd(), "logs");
        mkdirSync(logsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = path.join(logsDir, `ml-debug-${stamp}-empty-products.html`);
        writeFileSync(outPath, html, "utf8");
        logger.warn(`[Scraper] HTML salvo para debug: ${outPath}`);
        await this.saveDebugState(navPage, stamp, "empty-products");
        const imgPath = path.join(logsDir, `ml-debug-${stamp}-empty-products.png`);
        await navPage.screenshot({ path: imgPath, fullPage: true });
        logger.warn(`[Scraper] Screenshot salvo para debug: ${imgPath}`);
      } catch (err) {
        logger.warn("[Scraper] Falha ao salvar debug (HTML/screenshot).", err);
      }
    }

    return parsed;
  }

  async getReviews(_itemId: string): Promise<MLReviewsResponse | null> {
    return null;
  }

  async enrichWithRating(product: MLProduct): Promise<MLProduct> {
    return product;
  }

  buildAffiliateUrl(originalUrl: string | undefined, itemId?: string): string | undefined {
    if (!originalUrl) return undefined;

    // Prefer affiliate fragment used by ML affiliate toolbar
    if (itemId) {
      try {
        const url = new URL(originalUrl);
        url.hash = `polycard_client=affiliates&wid=${encodeURIComponent(itemId)}&sid=affiliates`;
        return url.toString();
      } catch {
        // fallback to original if URL parsing fails
      }
    }

    // Optional query-based tracking (fallback)
    const query = config.ml.affiliateQuery?.trim();
    if (!query) return originalUrl;
    const sep = originalUrl.includes("?") ? "&" : "?";
    return `${originalUrl}${sep}${query}`;
  }

  async fetchAllDeals(options: DealOptions): Promise<MLProduct[]> {
    const { keyword, categoryKey = "todas", maxPages = DEFAULT_MAX_PAGES, directUrl, forceOfferTag } = options;
    const categoryId = ML_CATEGORIES[categoryKey] || undefined;

    const all: MLProduct[] = [];
    const seen = new Set<string>();

    const pages = directUrl ? 1 : maxPages;

    for (let page = 0; page < pages; page++) {
      const offset = page * PAGE_SIZE;
      const items = await this.searchItems({
        categoryId,
        keyword,
        offset,
        directUrl,
        forceOfferTag,
      });

      let newOnes = 0;
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
        newOnes++;
      }

      logger.info(`[Scraper] ${categoryKey} p.${page + 1}: ${items.length} com desconto, ${newOnes} novos`);

      if (items.length < Math.floor(PAGE_SIZE / 3)) {
        break;
      }
    }

    return all;
  }

  async close(): Promise<void> {
    if (!this.context) return;
    await this.context.close();
    this.context = null;
  }

  private async extractProductsFromPage(
    page: Page,
    options: SearchOptions,
    forceOfferTag?: string,
  ): Promise<MLProduct[]> {
    try {
      const state = await page.evaluate(() => {
        const w = window as any;
        return (
          w.__PRELOADED_STATE__ ||
          w.__INITIAL_STATE__ ||
          w.__NEXT_DATA__ ||
          w.__SEARCH_STATE__ ||
          w._n?.ctx?.r?.initialState ||
          w._n?.ctx?.r?.appState ||
          w._n?.ctx?.r ||
          w._n?.ctx ||
          null
        );
      });
      if (process.env.ML_DEBUG_DUMP === "true") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await this.saveDebugState(page, stamp, "force");
      }
      const offerProducts = extractOfferProductsFromState(state, options, forceOfferTag);
      if (offerProducts.length > 0) {
        return offerProducts;
      }

      const { results: rawResults, tagMap } = extractResultsAndTagMapFromState(state);
      if (!rawResults || rawResults.length === 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await this.saveDebugState(page, stamp, "json-empty");
        return [];
      }

      return rawResults
        .map((item) => mapItemToProduct(item, options, tagMap))
        .filter((item): item is MLProduct => Boolean(item))
        .map((item) => applyForceOfferTag(item, forceOfferTag))
        .filter((item) => allowProductByOfferFlag(item, forceOfferTag));
    } catch (err) {
      logger.warn("[Scraper] Falha ao extrair JSON da pagina, usando fallback HTML.", err);
      return [];
    }
  }

  private extractProductsFromNetwork(
    payloads: Array<{ url: string; data: any }>,
    options: SearchOptions,
    forceOfferTag?: string,
  ): MLProduct[] {
    for (const payload of payloads) {
      const data = payload.data;
      const offerProducts = extractOfferProductsFromState(data, options, forceOfferTag);
      if (offerProducts.length > 0) return offerProducts;
      if (!data || !Array.isArray(data.results)) continue;
      const tagMap = extractTagMapFromState(data);
      const items = data.results
        .map((item: any) => mapItemToProduct(item, options, tagMap))
        .filter((item: MLProduct | null): item is MLProduct => Boolean(item))
        .map((item: MLProduct) => applyForceOfferTag(item, forceOfferTag))
        .filter((item: MLProduct) => allowProductByOfferFlag(item, forceOfferTag));
      if (items.length > 0) return items;
    }
    return [];
  }

  private async extractProductsFromJsonLd(
    page: Page,
    options: SearchOptions,
    forceOfferTag?: string,
  ): Promise<MLProduct[]> {
    try {
      const blocks = await page.$$eval("script[type='application/ld+json']", (nodes: Element[]) =>
        nodes.map((n) => n.textContent || ""),
      );
      const items: MLProduct[] = [];
      for (const raw of blocks) {
        if (!raw || raw.length < 5) continue;
        let data: any;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }
        const graph = Array.isArray(data?.["@graph"]) ? data["@graph"] : [];
        for (const node of graph) {
          if (!node || node["@type"] !== "Product") continue;
          const offer = node.offers ?? {};
          const url = String(offer.url ?? node.url ?? "");
          const id = extractIdFromUrl(url) || url;
          const price = getNumber(offer.price) ?? 0;
          if (!price || !url) continue;

          items.push({
            id,
            site_id: "MLB",
            category_id: String(options.categoryId ?? "SCRAPED"),
            seller_id: 0,
            title: String(node.name ?? ""),
            condition: "new",
            thumbnail: Array.isArray(node.image) ? String(node.image[0] ?? "") : String(node.image ?? ""),
            permalink: url,
            price,
            original_price: null,
            currency_id: String(offer.priceCurrency ?? "BRL"),
            available_quantity: 0,
            sold_quantity: 0,
            buying_mode: "buy_it_now",
            shipping: {
              free_shipping: false,
              store_pick_up: false,
              mode: "not_specified",
              logistic_type: "not_specified",
            },
            seller: { id: 0, nickname: String(node.brand?.name ?? "desconhecido") },
          });
        }
      }
      return items
        .map((item) => applyForceOfferTag(item, forceOfferTag))
        .filter((item) => allowProductByOfferFlag(item, forceOfferTag));
    } catch {
      return [];
    }
  }

  private async saveDebugState(page: Page, stamp: string, reason: string): Promise<void> {
    try {
      const state = await page.evaluate(() => {
        const w = window as any;
        return (
          w.__PRELOADED_STATE__ ||
          w.__INITIAL_STATE__ ||
          w.__NEXT_DATA__ ||
          w.__SEARCH_STATE__ ||
          w._n?.ctx?.r?.initialState ||
          w._n?.ctx?.r?.appState ||
          w._n?.ctx?.r ||
          w._n?.ctx ||
          null
        );
      });
      if (!state) return;
      const logsDir = path.join(process.cwd(), "logs");
      mkdirSync(logsDir, { recursive: true });
      const outPath = path.join(logsDir, `ml-debug-${stamp}-${reason}.json`);
      const json = JSON.stringify(state, null, 2);
      writeFileSync(outPath, json, "utf8");
      logger.warn(`[Scraper] JSON salvo para debug: ${outPath}`);
    } catch (err) {
      logger.warn("[Scraper] Falha ao salvar JSON de debug.", err);
    }
  }
}

function mapItemToProduct(
  item: any,
  options: SearchOptions,
  tagMap?: Record<string, string[]>,
): MLProduct | null {
  if (!item || typeof item !== "object") return null;

  const id = String(item.id ?? item.item_id ?? "");
  const title = String(item.title ?? item.name ?? "");
  const permalink = String(item.permalink ?? item.link ?? item.url ?? "");
  const idFromUrl = extractIdFromUrl(permalink);
  const finalId = idFromUrl ?? id;
  if (!finalId || !title || !permalink) return null;

  const price =
    getNumber(item.price) ??
    getNumber(item.sale_price?.amount) ??
    getNumber(item.sale_price?.price) ??
    getNumber(item.prices?.prices?.[0]?.amount) ??
    0;

  if (!price || price <= 0) return null;

  const original =
    getNumber(item.original_price) ??
    getNumber(item.prices?.prices?.[0]?.regular_amount) ??
    getNumber(item.prices?.prices?.[0]?.original_price) ??
    null;

  const sellerId = Number(item.seller_id ?? item.seller?.id ?? 0);
  const sellerNick = String(item.seller?.nickname ?? "desconhecido");

  const result: MLProduct = {
    id: finalId,
    site_id: String(item.site_id ?? "MLB"),
    category_id: String(item.category_id ?? options.categoryId ?? "SCRAPED"),
    seller_id: sellerId,
    title,
    condition: (item.condition as "new" | "used" | "not_specified") ?? "not_specified",
    thumbnail: String(item.thumbnail ?? item.thumbnail_id ?? ""),
    permalink,
    price,
    original_price: original,
    currency_id: String(item.currency_id ?? "BRL"),
    available_quantity: Number(item.available_quantity ?? 0),
    sold_quantity: Number(item.sold_quantity ?? item.sold ?? 0),
    buying_mode: String(item.buying_mode ?? "buy_it_now"),
    shipping: {
      free_shipping: Boolean(item.shipping?.free_shipping ?? item.free_shipping ?? false),
      store_pick_up: Boolean(item.shipping?.store_pick_up ?? false),
      mode: String(item.shipping?.mode ?? "not_specified"),
      logistic_type: String(item.shipping?.logistic_type ?? "not_specified"),
    },
    seller: { id: sellerId, nickname: sellerNick },
    installments: item.installments,
    domain_id: item.domain_id,
    discount_percentage: item.discount_percentage,
  };

  const offerTags = collectOfferTagsFromItem(item, tagMap);
  if (offerTags.length > 0) result._offerTags = offerTags;

  return result;
}

function allowProductByOfferFlag(product: MLProduct, forceOfferTag?: string): boolean {
  const onlyOffers = process.env.ML_ONLY_OFFERS === "true";
  if (!onlyOffers) return true;
  if (forceOfferTag) return true;
  return isOfferProduct(product);
}

function isOfferProduct(product: MLProduct): boolean {
  if (product._offerTags && product._offerTags.length > 0) return true;
  if (product.discount_percentage && product.discount_percentage > 0) return true;
  if (product.original_price && product.original_price > product.price) return true;
  return false;
}

function applyForceOfferTag(product: MLProduct, forceOfferTag?: string): MLProduct {
  if (forceOfferTag && (!product._offerTags || product._offerTags.length === 0)) {
    product._offerTags = [forceOfferTag];
  }
  return product;
}

function collectOfferTagsFromItem(
  item: any,
  tagMap?: Record<string, string[]>,
): string[] {
  const rawTags = new Set<string>();

  const itemTags = Array.isArray(item?.tags) ? item.tags : [];
  for (const t of itemTags) {
    if (t) rawTags.add(String(t));
  }

  if (item?.deal_of_the_day) rawTags.add("deal_of_the_day");
  if (item?.lightning_deal) rawTags.add("lightning_deal");
  if (item?.promotions && Array.isArray(item.promotions) && item.promotions.length > 0) {
    rawTags.add("promotions");
  }
  if (item?.promotion_id) rawTags.add("promotions");
  if (item?.discount_percentage) rawTags.add("discount");
  if (item?.prices?.prices?.[0]?.regular_amount && item?.prices?.prices?.[0]?.amount) {
    rawTags.add("discount");
  }

  const id = String(item?.id ?? item?.item_id ?? "");
  const mappedTags = id && tagMap ? tagMap[id] : undefined;
  if (mappedTags && mappedTags.length > 0) {
    for (const t of mappedTags) rawTags.add(String(t));
  }

  const labels = new Set<string>();
  for (const t of rawTags) {
    const label = tagLabelFromKey(t);
    if (label) labels.add(label);
  }

  return Array.from(labels);
}

function tagLabelFromKey(value: string): string | null {
  const key = normalizeText(String(value)).toLowerCase();
  if (!key) return null;
  if (key.includes("lightning") || key.includes("relampago")) return "Oferta relampago";
  if (key.includes("deal_of_the_day") || key.includes("oferta_do_dia")) return "Oferta do dia";
  if (key.includes("promot")) return "Promocao";
  if (key.includes("discount") || key.includes("off") || key.includes("price_reduction"))
    return "Desconto";
  if (key.includes("coupon") || key.includes("cupom")) return "Cupom";
  if (key.includes("good_price") || key.includes("goodprice")) return "Preco bom";
  if (key.includes("best_seller")) return "Mais vendido";
  if (key.includes("highlight")) return "Destaque";
  if (key.includes("benefit") || key.includes("beneficio")) return "Beneficio";
  if (key.includes("cashback")) return "Cashback";
  return null;
}

function extractResultsAndTagMapFromState(state: any): {
  results: any[];
  tagMap: Record<string, string[]>;
} {
  return {
    results: extractResultsFromState(state),
    tagMap: extractTagMapFromState(state),
  };
}

function extractTagMapFromState(state: any): Record<string, string[]> {
  const tagMap: Record<string, string[]> = {};
  if (!state || typeof state !== "object") return tagMap;

  const queue: any[] = [state];
  const seen = new Set<any>();
  let steps = 0;

  while (queue.length > 0 && steps < 2000) {
    const node = queue.shift();
    steps++;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const tagInfo = (node as any).tag_tracking_info;
    if (tagInfo && typeof tagInfo === "object") {
      for (const [tagKey, list] of Object.entries(tagInfo)) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const id =
            typeof entry === "string" || typeof entry === "number"
              ? String(entry)
              : String((entry as any)?.id ?? (entry as any)?.item_id ?? "");
          if (!id) continue;
          if (!tagMap[id]) tagMap[id] = [];
          tagMap[id].push(String(tagKey));
        }
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return tagMap;
}

function extractResultsFromState(state: any): any[] {
  const candidates = [
    state?.search?.results,
    state?.search?.data?.results,
    state?.search?.results?.results,
    state?.results,
    state?.data?.results,
    state?.initialState?.search?.results,
    state?.initialState?.search?.data?.results,
    state?.props?.pageProps?.initialState?.search?.results,
    state?.props?.pageProps?.initialState?.search?.data?.results,
    state?.props?.pageProps?.results,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && isLikelyProductArray(c)) return c;
  }

  const found = findResultsByShape(state);
  return found ?? [];
}

function isLikelyProductArray(arr: any[]): boolean {
  const first = arr[0];
  if (!first || typeof first !== "object") return false;
  const keys = Object.keys(first);
  const hasId = keys.includes("id") || keys.includes("item_id");
  const hasTitle = keys.includes("title") || keys.includes("name");
  const hasPrice = keys.includes("price") || keys.includes("original_price") || keys.includes("prices");
  const hasLink = keys.includes("permalink") || keys.includes("link") || keys.includes("url");
  return hasId && hasTitle && hasPrice && hasLink;
}

function findResultsByShape(root: any): any[] | null {
  const queue: any[] = [root];
  const seen = new Set<any>();
  let steps = 0;

  while (queue.length > 0 && steps < 2000) {
    const node = queue.shift();
    steps++;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node) && node.length > 0 && isLikelyProductArray(node)) {
      return node;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return null;
}

function getNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractIdFromUrl(url: string): string | null {
  if (!url) return null;
  const match = url.match(/MLB-?\d+|MLBU\d+/i);
  return match ? match[0] : null;
}

function extractOfferProductsFromState(
  state: any,
  options: SearchOptions,
  forceOfferTag?: string,
): MLProduct[] {
  const data = extractOffersData(state);
  const items = data?.items;
  if (!Array.isArray(items) || items.length === 0) return [];

  const products = items
    .map((item: any) => mapOfferItemToProduct(item, options))
    .filter((item: MLProduct | null): item is MLProduct => Boolean(item))
    .map((item) => applyForceOfferTag(item, forceOfferTag))
    .filter((item) => allowProductByOfferFlag(item, forceOfferTag));

  return products;
}

function extractOffersData(state: any): any | null {
  if (!state || typeof state !== "object") return null;
  const candidates = [
    state?.appProps?.pageProps?.data,
    state?.props?.pageProps?.data,
    state?.pageProps?.data,
    state?.data,
    state?.appProps?.data,
  ];
  for (const c of candidates) {
    if (c && Array.isArray(c.items)) return c;
  }
  return null;
}

function mapOfferItemToProduct(item: any, options: SearchOptions): MLProduct | null {
  const card = item?.card ?? item;
  const meta = card?.metadata ?? item?.metadata ?? {};
  const id = String(meta.id ?? meta.item_id ?? meta.product_id ?? "");

  const titleComp = getOfferComponent(card, "title");
  const title = String(
    titleComp?.title?.text ?? titleComp?.title ?? card?.title ?? item?.title ?? "",
  ).trim();

  const priceComp = getOfferComponent(card, "price")?.price ?? card?.price ?? item?.price;
  const current =
    getNumber(priceComp?.current_price?.value) ??
    getNumber(priceComp?.current_price?.price) ??
    getNumber(priceComp?.current_price?.amount) ??
    getNumber(priceComp?.price?.value) ??
    getNumber(priceComp?.price);
  if (!id || !title || !current) return null;

  let original =
    getNumber(priceComp?.previous_price?.value) ??
    getNumber(priceComp?.previous_price?.amount) ??
    getNumber(priceComp?.original_price?.value) ??
    getNumber(priceComp?.original_price);

  const discountPct = getNumber(priceComp?.discount?.value);
  if (!original && discountPct && discountPct > 0) {
    original = Number((current / (1 - discountPct / 100)).toFixed(2));
  }

  const reviewsComp = getOfferComponent(card, "reviews")?.reviews ?? {};
  const ratingAverage = getNumber(reviewsComp?.rating_average);
  const ratingTotal = getNumber(reviewsComp?.total);

  const shippingComp = getOfferComponent(card, "shipping")?.shipping ?? {};
  const shippingText = normalizeText(String(shippingComp?.text ?? ""));
  const freeShipping = /frete\s+gratis/i.test(shippingText);

  const sellerComp = getOfferComponent(card, "seller")?.seller ?? {};
  const sellerText = String(sellerComp?.text ?? "");
  const sellerNick = sellerText
    .replace(/^\s*por\s+/i, "")
    .replace(/\{.*?\}/g, "")
    .trim();

  const permalink = buildOfferPermalink(meta);
  const thumbnail = buildOfferThumbnail(card);

  const result: MLProduct = {
    id,
    site_id: "MLB",
    category_id: String(options.categoryId ?? "SCRAPED"),
    seller_id: 0,
    title,
    condition: "new",
    thumbnail,
    permalink,
    price: current,
    original_price: original ?? null,
    currency_id: "BRL",
    available_quantity: 0,
    sold_quantity: 0,
    buying_mode: "buy_it_now",
    shipping: {
      free_shipping: freeShipping,
      store_pick_up: false,
      mode: "not_specified",
      logistic_type: "not_specified",
    },
    seller: { id: 0, nickname: sellerNick || "desconhecido" },
  };

  if (discountPct) result.discount_percentage = discountPct;
  if (ratingAverage !== null) result.rating_average = ratingAverage;
  if (ratingTotal !== null) result.rating_total = ratingTotal;

  return result;
}

function getOfferComponent(card: any, type: string): any | null {
  const components = Array.isArray(card?.components) ? card.components : [];
  return components.find((c: any) => c?.type === type) ?? null;
}

function buildOfferPermalink(meta: any): string {
  const rawUrl = String(meta?.url ?? "");
  if (!rawUrl) return "";
  const base = normalizeUrl(rawUrl);
  const params = String(meta?.url_params ?? "");
  if (!params) return base;
  if (base.includes("?")) return base;
  if (params.startsWith("?")) return `${base}${params}`;
  return `${base}?${params}`;
}

function normalizeUrl(raw: string): string {
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const cleaned = raw.replace(/^\/+/, "");
  return `https://${cleaned}`;
}

function buildOfferThumbnail(card: any): string {
  const pictures = card?.pictures?.pictures;
  if (Array.isArray(pictures) && pictures.length > 0) {
    const pic = pictures[0];
    const id = String(pic?.id ?? "").trim();
    if (id) {
      return `https://http2.mlstatic.com/D_NQ_NP_2X_${id}-O.webp`;
    }
  }
  return "";
}

function inferOfferTagFromUrl(url: string): string | undefined {
  const normalized = normalizeText(String(url)).toLowerCase();
  if (normalized.includes("promotion_type=lightning")) return "Oferta relampago";
  if (normalized.includes("ofertas-relampago") || normalized.includes("relampago"))
    return "Oferta relampago";
  if (normalized.includes("deal_ids=")) return "Oferta do dia";
  if (normalized.includes("container_id=mlb1298579-1")) return "Preco imperdivel";
  if (normalized.includes("container_id=mlb779362-1") && normalized.includes("promotion_type=lightning"))
    return "Oferta relampago";
  if (normalized.includes("container_id=mlb779362-1")) return "Todas as ofertas";
  if (normalized.includes("ofertas-do-dia") || normalized.includes("oferta-do-dia"))
    return "Oferta do dia";
  if (normalized.includes("/ofertas")) return "Ofertas";
  if (normalized.includes("preco-imperdivel") || normalized.includes("preco-imperdiveis"))
    return "Preco imperdivel";
  if (normalized.includes("preco-imbativel") || normalized.includes("preco-inbativel"))
    return "Preco imbatavel";
  return undefined;
}
