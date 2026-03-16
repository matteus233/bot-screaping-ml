import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tokenManager } from "../api/tokenManager.ts";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parseCode(raw: string): string {
  try {
    const url = new URL(raw);
    const codeFromUrl = url.searchParams.get("code");
    return (codeFromUrl ?? raw).trim();
  } catch {
    return raw.trim();
  }
}

async function updateEnv(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  const envPath = ".env";
  const backupPath = ".env.bak";

  const hasEnvFile = existsSync(envPath);
  const content = hasEnvFile ? await readFile(envPath, "utf8") : "";

  if (hasEnvFile) {
    await copyFile(envPath, backupPath);
  }

  const lines = content ? content.split(/\r?\n/) : [];

  let hasAccess = false;
  let hasRefresh = false;

  const nextLines = lines.map((line) => {
    if (line.startsWith("ML_ACCESS_TOKEN=")) {
      hasAccess = true;
      return `ML_ACCESS_TOKEN=${tokens.accessToken}`;
    }

    if (line.startsWith("ML_REFRESH_TOKEN=")) {
      hasRefresh = true;
      return `ML_REFRESH_TOKEN=${tokens.refreshToken}`;
    }

    return line;
  });

  if (!hasAccess) nextLines.push(`ML_ACCESS_TOKEN=${tokens.accessToken}`);
  if (!hasRefresh) nextLines.push(`ML_REFRESH_TOKEN=${tokens.refreshToken}`);

  await writeFile(envPath, `${nextLines.filter(Boolean).join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const rawCode = getArg("--code") ?? getArg("-c") ?? process.argv[2];
  const verifier = getArg("--verifier") ?? getArg("-v");

  if (!rawCode) {
    console.error("Uso: npx tsx src/scripts/exchangeCodeCli.ts --code <authorization_code ou URL completa> --verifier <code_verifier>");
    process.exit(1);
  }

  const code = parseCode(rawCode);
  const tokenData = await tokenManager.exchangeCode(code, verifier);

  await updateEnv({
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
  });

  console.log("✅ Tokens atualizados no .env");
  console.log("ℹ️ Backup salvo em .env.bak (quando .env já existia)");
}

main().catch((error) => {
  console.error("❌ Falha ao trocar authorization_code:", error?.message ?? error);
  process.exit(1);
});
