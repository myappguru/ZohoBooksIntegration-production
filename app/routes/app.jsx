import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisProvider } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import Footer from "../components/Footer";
import { useTranslation } from "../locales/translation";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const t = useTranslation();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisProvider i18n={polarisTranslations}>
        <s-app-nav>
          <s-link href="/app">{t("app.nav.dashboard")}</s-link>
          <s-link href="/app/products">{t("app.nav.products")}</s-link>
          <s-link href="/app/customers">{t("app.nav.customers")}</s-link>
          <s-link href="/app/orders">{t("app.nav.orders")}</s-link>
          <s-link href="/app/inventory">{t("app.nav.inventory")}</s-link>
          <s-link href="/app/sync-history">{t("app.nav.syncHistory")}</s-link>
          <s-link href="/app/settings">{t("app.nav.settings")}</s-link>
          <s-link href="/app/help-support">{t("app.nav.helpSupport")}</s-link>
        </s-app-nav>

        <Outlet />

        <Footer />
      </PolarisProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};