import "dotenv/config";
import { tokenManager } from "./src/api/tokenManager.ts";
import { MLClient } from "./src/api/mlClient.ts";

const token = await tokenManager.getAccessToken();
console.log("✅ Token OK:", token.slice(0, 20) + "...");

const client = new MLClient();
const items = await client.searchItems({ categoryId: "MLB1051", limit: 5 });
console.log(`✅ API OK: ${items.length} produtos`);
items.forEach(p => console.log(`  - ${p.title} | R$${p.price}`));