// src/utils/formatter.ts - Formata mensagens para Telegram (HTML)
import type { MLProduct } from "../types/index.ts";

function stars(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.floor(rating)));
  return "⭐".repeat(full) + "☆".repeat(5 - full);
}

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function safePrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return "Preco indisponivel";
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "Preco indisponivel";
  return brl(n);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegram(p: MLProduct, affiliateUrl?: string): string {
  const computedDiscount = p.original_price && p.original_price > p.price
    ? ((p.original_price - p.price) / p.original_price) * 100
    : 0;
  const discount = p._discountPct ?? computedDiscount;
  const url = affiliateUrl ?? p.permalink ?? "";
  const offerTag = p._offerTags && p._offerTags.length > 0 ? p._offerTags[0] : "OFERTA";

  const lines = [`🔥 [${escapeHtml(offerTag)}] <b>${escapeHtml(p.title)}</b>`, ""];

  lines.push(`💰 <b>${safePrice(p.price)}</b>`);

  if (p.original_price && p.original_price !== p.price) {
    lines.push(`<s>${safePrice(p.original_price)}</s> -> <b>-${discount.toFixed(0)}% OFF</b>`);
  }

  lines.push(p.shipping?.free_shipping ? "🚚 Frete grátis" : "🚚 Frete pago");

  const meta: string[] = [];
  if (p.rating_average) meta.push(`${stars(p.rating_average)} ${p.rating_average.toFixed(1)}/5`);
  if (p.sold_quantity) meta.push(`🛒 ${p.sold_quantity.toLocaleString("pt-BR")} vendidos`);

  if (meta.length > 0) {
    lines.push("", meta.join(" | "));
  }

  lines.push("", `🔗 <a href=\"${url}\">Ver no Mercado Livre</a>`);
  return lines.join("\n");
}
