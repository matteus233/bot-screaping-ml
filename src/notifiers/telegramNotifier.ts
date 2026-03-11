// src/notifiers/telegramNotifier.ts — Telegraf + comandos específicos do ML
import { Telegraf, type Context } from "telegraf";
import { config, filterConfig } from "../config.ts";
import { DatabaseManager } from "../database/dbManager.ts";
import { formatTelegram } from "../utils/formatter.ts";
import { logger } from "../utils/logger.ts";
import { ML_CATEGORIES } from "../types/index.ts";
import type { MLProduct } from "../types/index.ts";

export class TelegramNotifier {
  private readonly bot: Telegraf;
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db  = db;
    this.bot = new Telegraf(config.telegram.token);
    this.registerCommands();
  }

  async sendProduct(product: MLProduct, affiliateUrl?: string): Promise<boolean> {
    if (!config.telegram.enabled) return false;

    const itemId = product.id;
    const shopId = String(product.seller_id);

    if (await this.db.wasSent(itemId, shopId, "telegram")) {
      logger.debug(`[Telegram] ${itemId} já enviado.`);
      return false;
    }

    const caption = formatTelegram(product, affiliateUrl);

    try {
      if (product.thumbnail) {
        await this.bot.telegram.sendPhoto(config.telegram.channelId, product.thumbnail, {
          caption,
          parse_mode: "HTML",
        });
      } else {
        await this.bot.telegram.sendMessage(config.telegram.channelId, caption, {
          parse_mode: "HTML",
        });
      }

      await this.db.markAsSent(itemId, shopId, "telegram");
      logger.info(`[Telegram] ✅ ${product.title.slice(0, 50)}`);
      return true;
    } catch (err) {
      logger.error(`[Telegram] Erro: ${err}`);
      return false;
    }
  }

  private registerCommands(): void {
    const bot = this.bot;

    bot.command("start", (ctx) => {
      ctx.replyWithHTML(
        "🛒 <b>Mercado Livre Promo Bot</b>\n\n" +
        "/status — configurações\n" +
        "/desconto [%] — desconto mínimo\n" +
        "/preco [max] — preço máximo\n" +
        "/novos — somente produtos novos on/off\n" +
        "/categoria — listar categorias\n" +
        "/setcat [cat] — filtrar categoria\n" +
        "/keyword add|remove|block [palavra]",
      );
    });

    bot.command("status",  (ctx) => this.cmdStatus(ctx));
    bot.command("filtros", (ctx) => this.cmdStatus(ctx));

    bot.command("desconto", (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /desconto 20");
      filterConfig.minDiscountPercent = val;
      void this.db.setConfig("minDiscountPercent", String(val));
      ctx.reply(`✅ Desconto mínimo: ${val}%`);
    });

    bot.command("preco", (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /preco 1000");
      filterConfig.maxPriceBRL = val;
      void this.db.setConfig("maxPriceBRL", String(val));
      ctx.reply(`✅ Preço máximo: R$ ${val.toFixed(2)}`);
    });

    bot.command("novos", (ctx) => {
      filterConfig.onlyNewCondition = !filterConfig.onlyNewCondition;
      ctx.reply(`✅ Somente novos: ${filterConfig.onlyNewCondition ? "ON" : "OFF"}`);
    });

    bot.command("categoria", (ctx) => {
      const list = Object.keys(ML_CATEGORIES).map((k) => `• ${k}`).join("\n");
      ctx.reply(`Categorias:\n${list}\n\nUso: /setcat eletronicos`);
    });

    bot.command("setcat", (ctx) => {
      const args = ctx.message.text.split(" ").slice(1);
      filterConfig.allowedCategories = args.includes("todas") ? [] : args;
      ctx.reply(`✅ Categorias: ${filterConfig.allowedCategories.join(", ") || "todas"}`);
    });

    bot.command("keyword", (ctx) => {
      const [, action, word] = ctx.message.text.split(" ");
      if (!action || !word) {
        return void ctx.reply("Uso: /keyword add|remove|block [palavra]");
      }
      switch (action.toLowerCase()) {
        case "add":
          filterConfig.keywordsWhitelist.push(word.toLowerCase());
          ctx.reply(`✅ '${word}' → whitelist`);
          break;
        case "remove":
          filterConfig.keywordsWhitelist = filterConfig.keywordsWhitelist.filter((k) => k !== word);
          ctx.reply(`✅ '${word}' removido`);
          break;
        case "block":
          filterConfig.keywordsBlacklist.push(word.toLowerCase());
          ctx.reply(`🚫 '${word}' → blacklist`);
          break;
      }
    });
  }

  private cmdStatus(ctx: Context): void {
    const cfg = filterConfig;
    ctx.replyWithHTML(
      "📊 <b>Status — ML Promo Bot</b>\n\n" +
      `• Desconto mínimo: <b>${cfg.minDiscountPercent}%</b>\n` +
      `• Preço máximo: <b>R$ ${cfg.maxPriceBRL}</b>\n` +
      `• Avaliação mínima: <b>${cfg.minRating} ⭐</b>\n` +
      `• Vendas mínimas: <b>${cfg.minSoldQuantity}</b>\n` +
      `• Somente novos: <b>${cfg.onlyNewCondition ? "✅" : "❌"}</b>\n` +
      `• Preço histórico: <b>${cfg.historicalPriceCheck ? "✅" : "❌"}</b>\n` +
      `• Categorias: <b>${cfg.allowedCategories.join(", ") || "todas"}</b>`,
    );
  }

  startPolling(): void {
    this.bot.launch().catch((err) => logger.error(`[Telegram] Polling falhou: ${err}`));
    process.once("SIGINT",  () => this.bot.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
    logger.info("[Telegram ML] Bot iniciado.");
  }

  stopPolling(): void { this.bot.stop(); }
}