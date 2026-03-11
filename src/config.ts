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
  minDiscountPercent:    15,
  maxPriceBRL:           2000,
  minPriceBRL:           10,
  minRating:             4.0,
  minRatingCount:        20,
  minSoldQuantity:       50,
  historicalPriceCheck:  true,
  maxPriceVsHistorical:  1.05,
  keywordsWhitelist:     [],
  keywordsBlacklist:     ["réplica", "replica", "importado sem nota"],
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
    baseUrl:      "api.mercadolibre.com",
  },
  telegram: {
    token:     env.TELEGRAM_BOT_TOKEN,
    channelId: env.TELEGRAM_CHANNEL_ID,
    enabled:   true,
  },
  rateLimit: {
    requestsPerMinute:    60,
    fetchIntervalMinutes: 60,
  },
  filter:      filterConfig,
  databaseUrl: env.DATABASE_URL,
  logLevel:    env.LOG_LEVEL,
  databasePath: "./data/database.sqlite",
};