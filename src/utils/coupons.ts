// src/utils/coupons.ts - Cupons do Mercado Livre (entrada manual)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export type MLCoupon = {
  title: string;
  code: string;
  url?: string;
  discount?: string;
  min?: string;
  expiresAt?: string; // YYYY-MM-DD ou ISO
  active?: boolean;
};

function getCouponsFilePath(): string {
  const envPath = process.env.ML_COUPONS_FILE?.trim();
  if (envPath) return envPath;
  return path.join(process.cwd(), "data", "ml-coupons.json");
}

export function loadCoupons(): MLCoupon[] {
  const filePath = getCouponsFilePath();
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(Boolean);
  } catch {
    return [];
  }
}

export function filterActiveCoupons(list: MLCoupon[]): MLCoupon[] {
  const now = Date.now();
  return list.filter((c) => {
    if (c.active === false) return false;
    if (!c.expiresAt) return true;
    const t = Date.parse(c.expiresAt);
    if (!Number.isFinite(t)) return true;
    return t >= now;
  });
}

export function dedupeCoupons(list: MLCoupon[]): MLCoupon[] {
  const seen = new Set<string>();
  const out: MLCoupon[] = [];
  for (const c of list) {
    const key = (c.code || "").trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function formatCouponMessage(coupon: MLCoupon): string {
  const parts: string[] = [];
  parts.push("🔥 Cupom Mercado Livre");
  parts.push(coupon.title?.trim() || "Cupom ativo");
  parts.push(`Codigo: ${coupon.code}`);
  if (coupon.discount) parts.push(`Desconto: ${coupon.discount}`);
  if (coupon.min) parts.push(`Minimo: ${coupon.min}`);
  if (coupon.expiresAt) {
    const d = new Date(coupon.expiresAt);
    if (!Number.isNaN(d.getTime())) {
      const dd = d.toLocaleDateString("pt-BR");
      parts.push(`Validade: ${dd}`);
    }
  }
  if (coupon.url) parts.push(coupon.url);
  return parts.join("\n");
}
