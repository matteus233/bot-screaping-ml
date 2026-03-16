import "dotenv/config";
import axios from "axios";
import { tokenManager } from "../api/tokenManager.ts";
import { logger } from "../utils/logger.ts";

const API_BASE = "https://api.mercadolibre.com";

type SearchItem = {
  id: string;
  title?: string;
  price?: number;
  original_price?: number | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function main(): Promise<void> {
  const token = await tokenManager.getAccessToken();
  const q = (process.env.ML_TEST_QUERY ?? "notebook").trim();
  const pages = Math.min(Math.max(Number(process.env.ML_TEST_PAGES ?? 5), 1), 20);
  const limit = 50;

  const http = axios.create({
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });

  logger.info(`[TEST] Token OK. Query="${q}" pages=${pages} limit=${limit}`);

  // 1) users/me
  try {
    const me = await http.get("/users/me");
    logger.info(`[TEST] /users/me OK (status ${me.status})`);
  } catch (err: any) {
    logger.error(`[TEST] /users/me falhou: ${err.response?.status} ${err.message}`);
  }

  // 2) search pages
  const ids: string[] = [];
  for (let page = 0; page < pages; page++) {
    const offset = page * limit;
    try {
      const res = await http.get("/sites/MLB/search", {
        params: { q, limit, offset },
      });
      const results = (res.data?.results ?? []) as SearchItem[];
      logger.info(
        `[TEST] /sites/MLB/search page=${page + 1} status=${res.status} results=${results.length}`,
      );
      for (const item of results) {
        if (item?.id) ids.push(String(item.id));
      }
      if (results.length < Math.floor(limit / 2)) break;
    } catch (err: any) {
      logger.error(
        `[TEST] /sites/MLB/search page=${page + 1} falhou: ${err.response?.status} ${err.message}`,
      );
      break;
    }
  }

  const uniqueIds = Array.from(new Set(ids)).slice(0, 40);
  logger.info(`[TEST] IDs coletados: ${uniqueIds.length}`);

  if (uniqueIds.length === 0) {
    logger.warn("[TEST] Nenhum ID coletado. Encerrando.");
    return;
  }

  // 3) items multiget
  for (const batch of chunk(uniqueIds, 20)) {
    try {
      const res = await http.get("/items", { params: { ids: batch.join(",") } });
      logger.info(`[TEST] /items batch=${batch.length} status=${res.status}`);
    } catch (err: any) {
      logger.error(`[TEST] /items falhou: ${err.response?.status} ${err.message}`);
    }
  }

  // 4) item single + reviews (first 3 ids)
  const sample = uniqueIds.slice(0, 3);
  for (const id of sample) {
    try {
      const item = await http.get(`/items/${id}`);
      logger.info(`[TEST] /items/${id} OK (status ${item.status})`);
    } catch (err: any) {
      logger.error(`[TEST] /items/${id} falhou: ${err.response?.status} ${err.message}`);
    }

    try {
      const rev = await http.get(`/reviews/item/${id}`);
      logger.info(`[TEST] /reviews/item/${id} OK (status ${rev.status})`);
    } catch (err: any) {
      logger.error(`[TEST] /reviews/item/${id} falhou: ${err.response?.status} ${err.message}`);
    }
  }
}

main().catch((err) => {
  logger.error(`[TEST] Erro fatal: ${err}`);
  process.exit(1);
});
