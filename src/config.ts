// src/config.ts
import "dotenv/config";
import { z } from "zod";
import type { BotConfig, FilterConfig } from "./types/index.js";

const EnvSchema = z.object({
  // Mercado Livre OAuth
  ML_APP_ID:        z.string().min(1, "ML_APP_ID é obrigatório"),
  ML_CLIENT_SECRET: z.string().min(1, "ML_CLIENT_SECRET é obrigatório"),
  ML_REDIRECT_URI:  z.string().default("https://localhost/callback"),
  ML_ACCESS_TOKEN:  z.string().default(""),
  ML_REFRESH_TOKEN: z.string().default(""),
  ML_AFFILIATE_QUERY: z.string().default(""),

  // Telegram (obrigatório)
  TELEGRAM_BOT_TOKEN:  z.string().min(1, "TELEGRAM_BOT_TOKEN é obrigatório"),
  TELEGRAM_CHANNEL_ID: z.string().min(1, "TELEGRAM_CHANNEL_ID é obrigatório"),

  // PostgreSQL
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatório"),
  LOG_LEVEL:    z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Erro nas variáveis de ambiente:");
  parsed.error.issues.forEach((i) => console.error(`  • ${i.path.join(".")}: ${i.message}`));
  process.exit(1);
}

const env = parsed.data;

export const filterConfig: FilterConfig = {
  minDiscountPercent:    0,
  maxPriceBRL:           100_000_000,
  minPriceBRL:           0,
  minRating:             0,
  minRatingCount:        0,
  minSoldQuantity:       0,
  historicalPriceCheck:  false,
  maxPriceVsHistorical:  1.05,
  keywordsWhitelist:     [],
  keywordsBlacklist:     [
    "capacitor",
    "diodo",
    "zener",
    "resistor",
    "transistor",
    "indutor",
    "bobina",
    "placa",
    "pcb",
    "componente",
    "eletronico",
    "eletronica",
    "peca",
    "pecas",
    "reposicao",
    "manutencao",
    "pickup",
    "roller",
    "rolete",
    "cabo",
    "usb",
    "conector",
    "microfone",
    "condensador",
    "mangueira",
    "anel",
    "oring",
    "o-ring",
    "vedacao",
    "vedação",
    "kit vedacao",
    "kit vedação",
  ],
  allowedCategories:     [],
  onlyNewCondition:      false,
  onlyFreeShipping:      false,
  minSellerReputation:   null,
};

export const config: BotConfig = {
  ml: {
    appId:        env.ML_APP_ID,
    clientSecret: env.ML_CLIENT_SECRET,
    redirectUri:  env.ML_REDIRECT_URI,
    accessToken:  env.ML_ACCESS_TOKEN,
    refreshToken: env.ML_REFRESH_TOKEN,
    baseUrl:      "https://api.mercadolibre.com",
    affiliateQuery: env.ML_AFFILIATE_QUERY,
  },
  telegram: {
    token:     env.TELEGRAM_BOT_TOKEN,
    channelId: env.TELEGRAM_CHANNEL_ID,
    enabled:   true,
  },
  marketing: {
    maxPerDay: 300,
    maxPerCycle: 20,
    minDiscountToSend: 5,
    preferredKeywords: [
      "smartphone",
      "celular",
      "iphone",
      "samsung",
      "xiaomi",
      "motorola",
      "tablet",
      "ipad",
      "galaxy tab",
      "redmi",
      "tv",
      "smart tv",
      "oled",
      "qled",
      "4k",
      "8k",
      "soundbar",
      "home theater",
      "projetor",
      "chromecast",
      "android tv",
      "tv box",
      "notebook",
      "laptop",
      "macbook",
      "ultrabook",
      "lenovo",
      "dell",
      "acer",
      "asus",
      "hp",
      "monitor",
      "gaming",
      "playstation",
      "ps5",
      "xbox",
      "nintendo",
    ],
    quietHours: {
      enabled: true,
      startHour: 23,
      endHour: 6,
      allowOnEventDays: true,
    },
    eventDays: [
      "2026-04-04",
      "2026-05-05",
      "2026-06-06",
      "2026-07-07",
      "2026-08-08",
      "2026-09-09",
      "2026-10-10",
      "2026-11-11",
      "2026-11-27",
      "2026-11-30",
    ],
  },
  rateLimit: {
    requestsPerMinute:    60,
    fetchIntervalMinutes: 30,
  },
  filter:      filterConfig,
  databaseUrl: env.DATABASE_URL,
  logLevel:    env.LOG_LEVEL,
};
