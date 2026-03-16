// src/api/tokenManager.ts - OAuth 2.0 Mercado Livre (PKCE + auto-refresh)
import axios from "axios";
import crypto from "crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import type { MLTokenResponse } from "../types/index.ts";

const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const ENV_PATH = ".env";
const ENV_BACKUP_PATH = ".env.bak";

// refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const ML_AUTH_HINTS = [
  "authorization_code expira rapido e so pode ser usado 1 vez.",
  "gere um novo code e troque imediatamente.",
  "ML_REDIRECT_URI deve ser igual ao cadastrado e ao usado na autorizacao.",
] as const;

export class TokenManager {
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;

  // PKCE - gerado por sessao de autorizacao
  private codeVerifier = "";
  private codeChallenge = "";

  constructor() {
    this.accessToken = config.ml.accessToken;
    this.refreshToken = config.ml.refreshToken;
    this.expiresAt = this.accessToken ? Date.now() + 6 * 60 * 60 * 1000 : 0;
  }

  // PKCE helpers
  private generatePKCE(): void {
    this.codeVerifier = crypto.randomBytes(32).toString("base64url");
    this.codeChallenge = crypto
      .createHash("sha256")
      .update(this.codeVerifier)
      .digest("base64url");
  }

  // Step 1 - authorization URL (also generates PKCE)
  getAuthorizationUrl(): string {
    this.generatePKCE();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.ml.appId,
      redirect_uri: config.ml.redirectUri,
      code_challenge: this.codeChallenge,
      code_challenge_method: "S256",
      scope: "read write offline_access",
    });

    logger.info("[TokenManager] code_verifier gerado (guarde para o exchangeCode):");
    logger.info(`[TokenManager] ${this.codeVerifier}`);

    return `https://auth.mercadolivre.com.br/authorization?${params}`;
  }

  // Step 2 - exchange code for tokens
  async exchangeCode(code: string, codeVerifier?: string): Promise<MLTokenResponse> {
    const verifier = codeVerifier ?? this.codeVerifier;

    if (!code?.trim()) {
      throw new Error("authorization_code vazio. Gere uma nova URL e copie o code.");
    }
    if (!verifier) {
      throw new Error(
        "code_verifier ausente. Use getAuthorizationUrl() ou passe manualmente.",
      );
    }

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.ml.appId,
        client_secret: config.ml.clientSecret,
        code,
        redirect_uri: config.ml.redirectUri,
        code_verifier: verifier,
      });

      const { data } = await axios.post<MLTokenResponse>(
        TOKEN_URL,
        body.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );

      await this.setTokens(data);

      logger.info("Tokens ML obtidos. Salve no .env:");
      logger.info(`ML_ACCESS_TOKEN=${data.access_token}`);
      logger.info(`ML_REFRESH_TOKEN=${data.refresh_token}`);

      return data;
    } catch (err: any) {
      logger.error("Erro ao trocar authorization_code:");
      logger.error(err.response?.data || err.message);

      const oauthError = err.response?.data?.error;
      if (oauthError === "invalid_grant") {
        logger.error("Dicas para corrigir invalid_grant:");
        ML_AUTH_HINTS.forEach((hint) => logger.error(`- ${hint}`));
      }

      throw err;
    }
  }

  // normal use - always returns a valid token
  async getAccessToken(): Promise<string> {
    if (this.isExpired()) await this.refresh();
    return this.accessToken;
  }

  private isExpired(): boolean {
    return Date.now() >= this.expiresAt - REFRESH_BUFFER_MS;
  }

  // refresh token (no PKCE)
  private async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("ML_REFRESH_TOKEN ausente. Refaça o fluxo OAuth.");
    }

    logger.info("[TokenManager] Renovando access_token...");

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
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );

      await this.setTokens(data);
      logger.info("[TokenManager] access_token renovado.");
    } catch (err: any) {
      logger.error("Erro ao renovar token:", err.response?.data || err.message);
      throw err;
    }
  }

  private async setTokens(data: MLTokenResponse): Promise<void> {
    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;

    config.ml.accessToken = this.accessToken;
    config.ml.refreshToken = this.refreshToken;

    await this.persistTokensToEnv();
  }

  private async persistTokensToEnv(): Promise<void> {
    const hasEnvFile = existsSync(ENV_PATH);
    const content = hasEnvFile ? await readFile(ENV_PATH, "utf8") : "";

    if (hasEnvFile) {
      await copyFile(ENV_PATH, ENV_BACKUP_PATH);
    }

    const lines = content ? content.split(/\r?\n/) : [];
    let hasAccess = false;
    let hasRefresh = false;

    const nextLines = lines.map((line) => {
      if (line.startsWith("ML_ACCESS_TOKEN=")) {
        hasAccess = true;
        return `ML_ACCESS_TOKEN=${this.accessToken}`;
      }
      if (line.startsWith("ML_REFRESH_TOKEN=")) {
        hasRefresh = true;
        return `ML_REFRESH_TOKEN=${this.refreshToken}`;
      }
      return line;
    });

    if (!hasAccess) nextLines.push(`ML_ACCESS_TOKEN=${this.accessToken}`);
    if (!hasRefresh) nextLines.push(`ML_REFRESH_TOKEN=${this.refreshToken}`);

    await writeFile(ENV_PATH, `${nextLines.filter(Boolean).join("\n")}\n`, "utf8");
  }
}

export const tokenManager = new TokenManager();
