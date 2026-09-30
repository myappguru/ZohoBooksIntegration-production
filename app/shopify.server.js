import "dotenv/config";
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { MySQLSessionStorage } from "@shopify/shopify-app-session-storage-mysql";
import { markShopInstalled } from "./models/shop.server";

const SHOP_DETAILS_QUERY = `#graphql
  query ShopDetailsForInstall {
    shop {
      name
      email
    }
  }
`;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new MySQLSessionStorage(
  `mysql://${encodeURIComponent(process.env.DB_USERNAME || "")}:${encodeURIComponent(process.env.DB_PASSWORD || "")}@${process.env.DB_HOST}:${process.env.DB_PORT}/${encodeURIComponent(process.env.DB_DATABASE || "")}`),
  distribution: AppDistribution.AppStore,
  hooks: {
    // Runs on install/reinstall: reactivates the shop row and records its
    // name/email (previously never populated).
    afterAuth: async ({ session, admin }) => {
      let shopName;
      let email;
      try {
        const response = await admin.graphql(SHOP_DETAILS_QUERY);
        const json = await response.json();
        shopName = json.data?.shop?.name;
        email = json.data?.shop?.email;
      } catch (error) {
        console.warn("Could not load shop details after auth", session.shop, error.message);
      }
      await markShopInstalled(session.shop, { shopName, email });
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
