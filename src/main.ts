import { logger } from "./utils/logger.ts";
import { MLBot } from "./scheduler.ts";
import { tokenManager } from "./api/tokenManager.ts";

async function main() {
  logger.info("════════════════════════════════════");
  logger.info("  🛒  Mercado Livre Promo Bot v1.0  ");
  logger.info("  📲  Canal: Telegram               ");
  logger.info("════════════════════════════════════");

  //await tokenManager.exchangeCode("TG-69b1cd8597b4350001aa65cb-1088974658");
  //process.exit(0);
  await new MLBot().start();
}

main().catch((err) => { logger.error("Fatal:", err); process.exit(1); });