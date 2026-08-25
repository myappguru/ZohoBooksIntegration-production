import { useState, useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useTranslation } from "../locales/translation";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export default function HelpSupport() {
  const t = useTranslation();
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const lastDismissTime = localStorage.getItem(
      "magZohoHelpPageRatingDismissedTime"
    );

    if (lastDismissTime) {
      const currentTime = new Date().getTime();
      const timeDifference = currentTime - parseInt(lastDismissTime, 10);
      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (timeDifference < twentyFourHours) {
        setIsDismissed(true);
      }
    }
  }, []);

  const handleRemove = () => {
    setIsDismissed(true);

    localStorage.setItem(
      "magZohoHelpPageRatingDismissedTime",
      new Date().getTime().toString()
    );
  };

  const openChat = () => {
    if (typeof window !== "undefined" && window.Tawk_API) {
      window.Tawk_API.toggle();
    }
  };

  const sendEmail = () => {
    window.location.href = "mailto:support@myappgurus.com";
  };

  const leaveReview = () => {
    window.open(
      "https://apps.shopify.com/form-builder-myappgurus#adp-reviews",
      "_blank"
    );
  };

  return (
    <s-page heading={t("helpSupport.title")}>
      <s-stack gap="base">

        {/* Contact Us */}
        <s-section>
          <s-stack gap="base">
            <s-heading level="2">
              {t("helpSupport.contactUs.title")}
            </s-heading>

            <s-paragraph>
              {t("helpSupport.contactUs.body")}
            </s-paragraph>

            <s-stack
              direction="inline"
              gap="base"
            >
              <s-button
                variant="primary"
                onClick={openChat}
              >
                {t("helpSupport.contactUs.btn1")}
              </s-button>

              <s-button
                variant="secondary"
                onClick={sendEmail}
              >
                {t("helpSupport.contactUs.btn2")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        {/* Rate App */}
        {!isDismissed && (
          <s-section>
            <s-stack gap="base">

              <s-stack
                direction="inline"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-heading level="2">
                  {t("helpSupport.rateApp.title")}
                </s-heading>

                <s-button
                  variant="tertiary"
                  onClick={handleRemove}
                  accessibilityLabel={t("helpSupport.dismiss")}
                >
                  ×
                </s-button>
              </s-stack>

              <s-paragraph>
                {t("helpSupport.rateApp.body")}
              </s-paragraph>

              <s-button
                variant="secondary"
                onClick={leaveReview}
              >
                {t("helpSupport.rateApp.btn")}
              </s-button>

            </s-stack>
          </s-section>
        )}

      </s-stack>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};