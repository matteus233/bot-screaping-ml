import { logger } from "./utils/logger.js";
import { MLBot } from "./scheduler.js";
import { tokenManager } from "./api/tokenManager.js";

async function main() {
  logger.info("════════════════════════════════════");
  logger.info("  🛒  Mercado Livre Promo Bot v1.0  ");
  logger.info("  📲  Canal: Telegram               ");
  logger.info("════════════════════════════════════");

  //await tokenManager.exchangeCode("TG-69b06f531a55530001b85365-1088974658");
  //process.exit(0);
  await new MLBot().start();
}

main().catch((err) => { logger.error("Fatal:", err); process.exit(1); });