// OAuth 2.0 do Mercado Livre com auto-refresh
import axios from "axios";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import type { MLTokenResponse } from "../types/index.ts";

const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

// renova 5 minutos antes de expirar
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const ML_AUTH_HINTS = [
  "authorization_code expira rápido e só pode ser usado 1 vez.",
  "gere um novo code e troque imediatamente.",
  "ML_REDIRECT_URI deve ser exatamente igual ao cadastrado no app e ao usado na autorização.",
] as const;

export class TokenManager {
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;

  constructor() {
    this.accessToken = config.ml.accessToken;
    this.refreshToken = config.ml.refreshToken;

    // se já existe token no .env assume 6h
    this.expiresAt = this.accessToken
      ? Date.now() + 6 * 60 * 60 * 1000
      : 0;
  }

  // ──────────────────────────────────────────────
  // URL de autorização (use uma vez)
  // ──────────────────────────────────────────────

  getAuthorizationUrl(): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.ml.appId,
      redirect_uri: config.ml.redirectUri,
    });

    return `https://auth.mercadolivre.com.br/authorization?${params}`;
  }

  // ──────────────────────────────────────────────
  // troca authorization_code por tokens
  // ──────────────────────────────────────────────

  async exchangeCode(code: string): Promise<MLTokenResponse> {
    if (!code?.trim()) {
      throw new Error("authorization_code vazio. Gere uma nova URL de autorização e copie o ?code= completo.");
    }

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.ml.appId,
        client_secret: config.ml.clientSecret,
        code,
        redirect_uri: config.ml.redirectUri,
      });

      const { data } = await axios.post<MLTokenResponse>(
        TOKEN_URL,
        body.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      this.setTokens(data);

      logger.info("✅ Tokens ML obtidos via authorization_code.");
      logger.info("Salve no .env:");
      logger.info(`ML_ACCESS_TOKEN=${data.access_token}`);
      logger.info(`ML_REFRESH_TOKEN=${data.refresh_token}`);

      return data;

    } catch (err: any) {
      logger.error("❌ Erro ao trocar authorization_code:");
      logger.error(err.response?.data || err.message);

      const oauthError = err.response?.data?.error;
      if (oauthError === "invalid_grant") {
        logger.error("Dicas para corrigir invalid_grant:");
        ML_AUTH_HINTS.forEach((hint) => logger.error(`• ${hint}`));
      }

      throw err;
    }
  }

  // ──────────────────────────────────────────────
  // retorna sempre token válido
  // ──────────────────────────────────────────────

  async getAccessToken(): Promise<string> {
    if (this.isExpired()) {
      await this.refresh();
    }

    return this.accessToken;
  }

  private isExpired(): boolean {
    return Date.now() >= this.expiresAt - REFRESH_BUFFER_MS;
  }

  // ──────────────────────────────────────────────
  // refresh automático
  // ──────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error(
        "ML_REFRESH_TOKEN ausente.\n" +
        "1. Acesse: " + this.getAuthorizationUrl() + "\n" +
        "2. Copie o ?code= da URL\n" +
        "3. Rode tokenManager.exchangeCode(code)"
      );
    }

    logger.info("🔄 Renovando access_token do Mercado Livre...");

    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.ml.appId,
        client_secret: config.ml.clientSecret,
        refresh_token: this.refreshToken,
      });

      const { data } = await axios.post<MLTokenResponse>(
        TOKEN_URL,
        body.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      this.setTokens(data);

      logger.info("✅ access_token renovado.");

    } catch (err: any) {
      logger.error("❌ Erro ao renovar token:");
      logger.error(err.response?.data || err.message);
      throw err;
    }
  }

  // ──────────────────────────────────────────────
  // atualiza tokens em memória
  // ──────────────────────────────────────────────

  private setTokens(data: MLTokenResponse): void {
    this.accessToken = data.access_token;
    if (data.refresh_token){
      this.refreshToken = data.refresh_token;
    }
    this.expiresAt = Date.now() + data.expires_in * 1000;

    config.ml.accessToken = this.accessToken;
    config.ml.refreshToken = this.refreshToken;
  }
}

export const tokenManager = new TokenManager();
