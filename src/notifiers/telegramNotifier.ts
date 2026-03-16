// src/notifiers/telegramNotifier.ts - Telegraf + comandos especificos do ML
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
  private readonly channelId: string;

  constructor(db: DatabaseManager) {
    this.db = db;
    this.channelId = config.telegram.channelId;
    this.bot = new Telegraf(config.telegram.token);
    this.registerCommands();
  }

  async sendProduct(product: MLProduct, affiliateUrl?: string): Promise<boolean> {
    if (!config.telegram.enabled) return false;

    const itemId = product.id;
    const shopId = String(product.seller_id);

    if (await this.db.wasSent(itemId, shopId, "telegram")) {
      logger.debug(`[Telegram] ${itemId} ja enviado.`);
      return false;
    }

    const caption = formatTelegram(product, affiliateUrl);

    try {
      if (product.thumbnail) {
        try {
          await this.bot.telegram.sendPhoto(this.channelId, product.thumbnail, {
            caption,
            parse_mode: "HTML",
          });
        } catch (err) {
          logger.warn(`[Telegram] Falha ao enviar foto, enviando texto: ${err}`);
          await this.bot.telegram.sendMessage(this.channelId, caption, {
            parse_mode: "HTML",
          });
        }
      } else {
        await this.bot.telegram.sendMessage(this.channelId, caption, {
          parse_mode: "HTML",
        });
      }

      await this.db.markAsSent(itemId, shopId, "telegram");
      logger.info(`[Telegram] OK ${product.title.slice(0, 50)}`);
      await this.notifyAlerts(product, affiliateUrl);
      return true;
    } catch (err) {
      logger.error(`[Telegram] Erro: ${err}`);
      return false;
    }
  }

  async notifyAlerts(product: MLProduct, affiliateUrl?: string): Promise<void> {
    const itemId = product.id;
    const shopId = String(product.seller_id);
    const alerts = await this.db.getAlertsToNotify({
      itemId,
      shopId,
      name: product.title ?? "",
    });
    for (const a of alerts) {
      const note =
        `Alerta: produto encontrado\n` +
        `${product.title ?? "Produto"}\n` +
        `${affiliateUrl ?? product.permalink ?? ""}`;
      await this.bot.telegram.sendMessage(String(a.chatId), note).catch(() => {});
    }
  }

  private registerCommands(): void {
    const bot = this.bot;

    bot.command("start", (ctx) => {
      ctx.replyWithHTML(
        "<b>Mercado Livre Promo Bot</b>\n\n" +
          "/status - configuracoes\n" +
          "/desconto [%] - desconto minimo\n" +
          "/preco [max] - preco maximo\n" +
          "/novos - somente produtos novos on/off\n" +
          "/categoria - listar categorias\n" +
          "/setcat [cat] - filtrar categoria\n" +
          "/keyword add|remove|block [palavra]\n" +
          "/alert [palavra|link]\n" +
          "/alertlist | /alertremove [id] | /alertclear\n" +
          "/alerthelp\n" +
          "/testmsg - enviar mensagem de teste",
      );
    });

    bot.command("status", (ctx) => this.cmdStatus(ctx));
    bot.command("filtros", (ctx) => this.cmdStatus(ctx));

    bot.command("desconto", (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /desconto 20");
      filterConfig.minDiscountPercent = val;
      void this.db.setConfig("minDiscountPercent", String(val));
      ctx.reply(`Desconto minimo: ${val}%`);
    });

    bot.command("preco", (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /preco 1000");
      filterConfig.maxPriceBRL = val;
      void this.db.setConfig("maxPriceBRL", String(val));
      ctx.reply(`Preco maximo: R$ ${val.toFixed(2)}`);
    });

    bot.command("novos", (ctx) => {
      filterConfig.onlyNewCondition = !filterConfig.onlyNewCondition;
      ctx.reply(`Somente novos: ${filterConfig.onlyNewCondition ? "ON" : "OFF"}`);
    });

    bot.command("categoria", (ctx) => {
      const list = Object.keys(ML_CATEGORIES).map((k) => `- ${k}`).join("\n");
      ctx.reply(`Categorias:\n${list}\n\nUso: /setcat eletronicos`);
    });

    bot.command("setcat", (ctx) => {
      const args = ctx.message.text.split(" ").slice(1);
      filterConfig.allowedCategories = args.includes("todas") ? [] : args;
      ctx.reply(`Categorias: ${filterConfig.allowedCategories.join(", ") || "todas"}`);
    });

    bot.command("keyword", (ctx) => {
      const [, action, word] = ctx.message.text.split(" ");
      if (!action || !word) {
        return void ctx.reply("Uso: /keyword add|remove|block [palavra]");
      }
      switch (action.toLowerCase()) {
        case "add":
          filterConfig.keywordsWhitelist.push(word.toLowerCase());
          ctx.reply(`'${word}' -> whitelist`);
          break;
        case "remove":
          filterConfig.keywordsWhitelist = filterConfig.keywordsWhitelist.filter((k) => k !== word);
          ctx.reply(`'${word}' removido`);
          break;
        case "block":
          filterConfig.keywordsBlacklist.push(word.toLowerCase());
          ctx.reply(`'${word}' -> blacklist`);
          break;
      }
    });

    bot.command("testmsg", async (ctx) => {
      try {
        await this.bot.telegram.sendMessage(
          this.channelId,
          "Teste de envio do Mercado Livre Promo Bot.",
        );
        ctx.reply("Mensagem de teste enviada.");
      } catch (err) {
        logger.error(`[Telegram] Erro no teste: ${err}`);
        ctx.reply("Falha ao enviar mensagem de teste. Veja o log.");
      }
    });

    bot.command("alert", async (ctx) => {
      return void this.handleAlertCommand(ctx, ctx.message.text);
    });

    bot.command("alertlist", async (ctx) => {
      const list = await this.db.listAlerts(ctx.from.id);
      if (list.length === 0) {
        return void ctx.reply("Voce nao tem alertas ativos.");
      }
      const lines = list.map((a) => {
        if (a.itemId && a.shopId) return `#${a.id} produto ${a.itemId}`;
        return `#${a.id} palavra \"${a.keyword}\"`;
      });
      ctx.reply(`Seus alertas:\n${lines.join("\n")}`);
    });

    bot.command("alertremove", async (ctx) => {
      const id = parseInt(ctx.message.text.split(" ")[1] ?? "", 10);
      if (Number.isNaN(id)) return void ctx.reply("Uso: /alertremove 123");
      const ok = await this.db.removeAlert(ctx.from.id, id);
      ctx.reply(ok ? "Alerta removido." : "Alerta nao encontrado.");
    });

    bot.command("alertclear", async (ctx) => {
      const count = await this.db.clearAlerts(ctx.from.id);
      ctx.reply(`Alertas removidos: ${count}`);
    });

    bot.command("alerthelp", (ctx) => {
      ctx.reply(
        "Alertas:\n" +
          "/alert hidratante\n" +
          "/alert smartphone\n" +
          "/alert https://www.mercadolivre.com.br/... (link do produto)\n\n" +
          "Gerenciar:\n" +
          "/alertlist\n" +
          "/alertremove 123\n" +
          "/alertclear",
      );
    });

    bot.command("alerttest", async (ctx) => {
      if (ctx.chat?.type !== "private") {
        return void ctx.reply("Para testar alertas, fale comigo no privado.");
      }
      const list = await this.db.listAlerts(ctx.from.id);
      if (list.length === 0) {
        return void ctx.reply("Crie um alerta primeiro com /alert.");
      }
      await this.bot.telegram
        .sendMessage(String(ctx.from.id), "Teste de alerta: este e um aviso simulado.")
        .catch(() => {});
      ctx.reply("Teste enviado no privado.");
    });

    bot.command("chatid", (ctx) => {
      const chatId = ctx.chat?.id;
      const type = ctx.chat?.type ?? "unknown";
      ctx.reply(`chatId: ${chatId} | tipo: ${type}`);
    });
  }

  private async handleAlertCommand(ctx: Context, rawText: string): Promise<void> {
    if (ctx.chat?.type !== "private") {
      return void ctx.reply("Para receber alertas, fale comigo no privado.");
    }
    if (!ctx.from?.id) {
      return void ctx.reply("Nao foi possivel identificar o usuario.");
    }
    try {
      const text = rawText.split(" ").slice(1).join(" ").trim();
      if (!text) {
        return void ctx.reply(
          "Uso: /alert [palavra-chave ou link ML]\nEx: /alert smart tv",
        );
      }

      const idMatch = text.match(/MLB-?\d+/i);
      if (idMatch) {
        const itemId = idMatch[0];
        const id = await this.db.addAlert({
          userId: ctx.from.id,
          chatId: ctx.from.id,
          itemId,
        });
        return void ctx.reply(`Alerta criado (#${id}) para o produto ${itemId}.`);
      }

      const keyword = text.toLowerCase();
      const id = await this.db.addAlert({
        userId: ctx.from.id,
        chatId: ctx.from.id,
        keyword,
      });
      return void ctx.reply(`Alerta criado (#${id}) para a palavra \"${keyword}\".`);
    } catch (err) {
      logger.error(`[Telegram] Erro ao criar alerta: ${err}`);
      return void ctx.reply("Erro ao criar alerta. Tente novamente.");
    }
  }

  private cmdStatus(ctx: Context): void {
    const cfg = filterConfig;
    ctx.replyWithHTML(
      "<b>Status - ML Promo Bot</b>\n\n" +
        `- Desconto minimo: <b>${cfg.minDiscountPercent}%</b>\n` +
        `- Preco maximo: <b>R$ ${cfg.maxPriceBRL}</b>\n` +
        `- Avaliacao minima: <b>${cfg.minRating}</b>\n` +
        `- Vendas minimas: <b>${cfg.minSoldQuantity}</b>\n` +
        `- Somente novos: <b>${cfg.onlyNewCondition ? "sim" : "nao"}</b>\n` +
        `- Preco historico: <b>${cfg.historicalPriceCheck ? "sim" : "nao"}</b>\n` +
        `- Categorias: <b>${cfg.allowedCategories.join(", ") || "todas"}</b>`,
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
