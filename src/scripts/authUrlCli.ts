import { tokenManager } from "../api/tokenManager.ts";

const url = tokenManager.getAuthorizationUrl();
console.log(url);
