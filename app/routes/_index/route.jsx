import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";
import { useTranslation } from "../../locales/translation";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop") || url.searchParams.get("host")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();
  const t = useTranslation();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>{t("landing.heading")}</h1>
        <p className={styles.text}>
          {t("landing.subheading")}
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>{t("landing.shopDomain")}</span>
              <input className={styles.input} type="text" name="shop" />
              <span>{t("landing.shopExample")}</span>
            </label>
            <button className={styles.button} type="submit">
              {t("landing.loginButton")}
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>{t("landing.productFeature")}</strong>. {t("landing.productFeatureDetail")}
          </li>
          <li>
            <strong>{t("landing.productFeature")}</strong>. {t("landing.productFeatureDetail")}
          </li>
          <li>
            <strong>{t("landing.productFeature")}</strong>. {t("landing.productFeatureDetail")}
          </li>
        </ul>
      </div>
    </div>
  );
}
