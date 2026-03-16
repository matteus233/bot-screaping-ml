// src/utils/formatter.ts - Formata mensagens para Telegram (HTML)
import type { MLProduct } from "../types/index.ts";

function stars(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.floor(rating)));
  return "⭐".repeat(full) + "☆".repeat(5 - full);
}

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegram(p: MLProduct, affiliateUrl?: string): string {
  const discount = p._discountPct ?? 0;
  const url = affiliateUrl ?? p.permalink ?? "";
  const condition = p.condition === "new" ? "Novo" : "Usado";
  const histMin = p._historicalMin;
  const offerTag = p._offerTags && p._offerTags.length > 0 ? p._offerTags[0] : "OFERTA";

  const lines = [`🔥 [${escapeHtml(offerTag)}] <b>${escapeHtml(p.title)}</b>`, ""];

  lines.push(`💰 <b>${brl(p.price)}</b>`);

  if (p.original_price && p.original_price !== p.price) {
    lines.push(`<s>${brl(p.original_price)}</s> -> <b>-${discount.toFixed(0)}% OFF</b>`);
  }

  if (histMin && histMin < p.price * 0.98) {
    lines.push(`Minimo historico: ${brl(histMin)}`);
  }

  if (p.shipping?.free_shipping) {
    lines.push("Frete gratis");
  }

  if (p.installments && p.installments.rate === 0) {
    lines.push(
      `Parcelamento: ${p.installments.quantity}x ${brl(p.installments.amount)} sem juros`,
    );
  }

  const meta: string[] = [];
  if (p.rating_average) meta.push(`${stars(p.rating_average)} ${p.rating_average.toFixed(1)}/5`);
  if (p.sold_quantity) meta.push(`🛒 ${p.sold_quantity.toLocaleString("pt-BR")} vendidos`);
  if (meta.length === 0) meta.push(`Condicao: ${condition}`);

  lines.push("", meta.join(" | "), "", `🔗 <a href=\"${url}\">Ver no Mercado Livre</a>`);
  return lines.join("\n");
}
