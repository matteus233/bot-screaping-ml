// src/types/index.ts — Tipos do Mercado Livre Promo Bot

// ──────────────────────────────────────────────
//  OAuth
// ──────────────────────────────────────────────

export interface MLTokenResponse {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;   // segundos — tipicamente 21600 (6h)
  token_type:    string;
  scope:         string;
  user_id:       number;
}

// ──────────────────────────────────────────────
//  Produto (resposta real da API /sites/MLB/search)
// ──────────────────────────────────────────────

export interface MLPrice {
  amount:         number;
  currency_id:    string;
  decimal_places: number;
}

export interface MLInstallments {
  quantity:    number;
  amount:      number;
  currency_id: string;
  rate:        number;
}

export interface MLSeller {
  id:       number;
  nickname: string;
  power_seller_status?: "gold" | "silver" | "platinum" | null;
  reputation_level_id?: string;
}

export interface MLShipping {
  free_shipping:    boolean;
  store_pick_up:   boolean;
  mode:            string;
  logistic_type:   string;
}

export interface MLAttribute {
  id:          string;
  name:        string;
  value_name:  string | null;
}

export interface MLPromotion {
  id:   string;
  type: "price_discount" | "lightning_deal" | "deal_of_the_day" | string;
}

export interface MLProduct {
  // ── Identificadores ──
  id:          string;
  site_id:     string;            // "MLB"
  category_id: string;
  seller_id:   number;

  // ── Dados básicos ──
  title:      string;
  condition:  "new" | "used" | "not_specified";
  thumbnail:  string;
  permalink:  string;
  domain_id?: string;

  // ── Preços ──
  price:          number;
  original_price: number | null;
  currency_id:    string;
  base_price?:    number;
  sale_price?:    MLPrice | null;

  // ── Estoque e vendas ──
  available_quantity: number;
  sold_quantity:      number;
  buying_mode:        "buy_it_now" | "auction" | string;

  // ── Promoção ──
  discount_percentage?: number;
  deal_ids?:            string[];
  promotions?:          MLPromotion[];

  // ── Frete ──
  shipping: MLShipping;

  // ── Parcelamento ──
  installments?: MLInstallments;

  // ── Vendedor ──
  seller: MLSeller;

  // ── Atributos extras ──
  attributes?: MLAttribute[];

  // ── Avaliações (endpoint separado /reviews/item/:id) ──
  rating_average?: number;
  rating_total?:   number;

  // ── Campos enriquecidos pelo bot (prefixo _) ──
  _discountPct?:   number;
  _historicalMin?: number;
  _affiliateUrl?:  string;
}

// ──────────────────────────────────────────────
//  Respostas da API
// ──────────────────────────────────────────────

export interface MLPaging {
  total:            number;
  primary_results?: number;
  offset:           number;
  limit:            number;
}

export interface MLSearchResponse {
  site_id:  string;
  results:  MLProduct[];
  paging:   MLPaging;
  sort?:    { id: string; name: string };
  filters?: unknown[];
}

export interface MLReviewsResponse {
  item_id:        string;
  rating_average: number;
  total:          number;
}

export interface MLCategoryResponse {
  id:       string;
  name:     string;
  path_from_root: Array<{ id: string; name: string }>;
}

// ──────────────────────────────────────────────
//  Configuração e filtros
// ──────────────────────────────────────────────

export interface FilterConfig {
  minDiscountPercent:   number;
  maxPriceBRL:          number;
  minPriceBRL:          number;
  minRating:            number;
  minRatingCount:       number;
  minSoldQuantity:      number;
  historicalPriceCheck: boolean;
  maxPriceVsHistorical: number;
  keywordsWhitelist:    string[];
  keywordsBlacklist:    string[];
  allowedCategories:    string[];
  onlyNewCondition:     boolean;
  onlyFreeShipping:     boolean;    // filtro extra específico do ML
  minSellerReputation:  SellerReputation | null;
}

export type SellerReputation = "green" | "light_green" | "yellow" | "orange" | "red";

export interface BotConfig {
  ml: {
    appId:        string;
    clientSecret: string;
    redirectUri:  string;
    accessToken:  string;
    refreshToken: string;
    baseUrl:      string;
  };
  telegram: {
    token:     string;
    channelId: string;
    enabled:   boolean;
  };
  /*whatsapp?: {
    accountSid:  string;
    authToken:   string;
    fromNumber:  string;
    toNumber:    string;
    enabled:     false;
  };*/
  rateLimit: {
    requestsPerMinute:    number;
    fetchIntervalMinutes: number;
  };
  filter:      FilterConfig;
  databaseUrl: string;
  logLevel:    string;
}

export type NotificationChannel = "telegram";

export interface FilterResult {
  passed: boolean;
  reason: string;
}

// ──────────────────────────────────────────────
//  Categorias ML Brasil (IDs oficiais)
// ──────────────────────────────────────────────

export const ML_CATEGORIES: Record<string, string> = {
  eletronicos:      "MLB1000",
  celulares:        "MLB1051",
  computadores:     "MLB1648",
  videogames:       "MLB1144",
  tv_audio:         "MLB1002",
  cameras:          "MLB1040",
  casa_jardim:      "MLB1574",
  esportes:         "MLB1276",
  moda:             "MLB1430",
  beleza:           "MLB1246",
  automotivo:       "MLB1743",
  ferramentas:      "MLB1039",
  bebes:            "MLB5726",
  livros:           "MLB1169",
  brinquedos:       "MLB1132",
  animais:          "MLB1tens",
  industria:        "MLB1500",
  todas:            "",
} as const;

export type CategoryKey = keyof typeof ML_CATEGORIES;