// src/utils/formatter.ts — Formata mensagens para Telegram (HTML)
import type { MLProduct } from "../types/index.ts";

function stars(rating: number): string {
  return "⭐".repeat(Math.floor(rating)) + "☆".repeat(5 - Math.floor(rating));
}

function badge(pct: number): string {
  if (pct >= 60) return "🔥🔥🔥";
  if (pct >= 40) return "🔥🔥";
  if (pct >= 20) return "🔥";
  return "🏷️";
}

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegram(p: MLProduct, affiliateUrl?: string): string {
  const discount  = p._discountPct ?? 0;
  const url       = affiliateUrl ?? p.permalink ?? "";
  const condition = p.condition === "new" ? "Novo" : "Usado";
  const histMin   = p._historicalMin;

  const lines = [
    `${badge(discount)} <b>${escapeHtml(p.title)}</b>`,
    "",
    `💰 <b>${brl(p.price)}</b>`,
  ];

  if (p.original_price && p.original_price !== p.price) {
    lines.push(`<s>${brl(p.original_price)}</s> → <b>-${discount.toFixed(0)}% OFF</b>`);
  }

  if (histMin && histMin < p.price * 0.98) {
    lines.push(`📉 Mínimo histórico: ${brl(histMin)}`);
  }

  if (p.shipping?.free_shipping) {
    lines.push("🚚 Frete grátis");
  }

  if (p.installments && p.installments.rate === 0) {
    lines.push(
      `💳 ${p.installments.quantity}x ${brl(p.installments.amount)} sem juros`,
    );
  }

  const meta: string[] = [`📦 ${condition}`];
  if (p.rating_average) meta.push(`${stars(p.rating_average)} ${p.rating_average.toFixed(1)}/5`);
  if (p.sold_quantity)  meta.push(`🛒 ${p.sold_quantity.toLocaleString("pt-BR")} vendidos`);
  if (p.seller?.nickname) meta.push(`🏪 ${escapeHtml(p.seller.nickname)}`);

  lines.push("", meta.join(" · "), "", `🔗 <a href="${url}">Ver no Mercado Livre</a>`);
  return lines.join("\n");
}