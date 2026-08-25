import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import { useTranslation } from "../../locales/translation";

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;
  const t = useTranslation();

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">
          <s-section heading={t("login.pageTitle")}>
            <s-text-field
              name="shop"
              label={t("login.shopDomain")}
              details={t("login.shopDetails")}
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop ? t(errors.shop) : undefined}
            ></s-text-field>
            <s-button type="submit">{t("login.submit")}</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
