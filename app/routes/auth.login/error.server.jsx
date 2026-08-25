import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

export function loginErrorMessage(loginErrors) {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "login.error.missingShop" };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "login.error.invalidShop" };
  }

  return {};
}
