import { useTranslation } from "../locales/translation";
import "./Footer.css";

// Same issue as OtherApps.jsx's carousel: `Footer.css`'s structural rules
// (the flex `gap` that's supposed to space out the copyright text, dividers,
// and links) weren't taking effect in this environment - visible as
// "Reserved.|Privacy Policy|Terms of Service" jammed together with no
// spacing. Applied inline instead, since inline styles can't be silently
// dropped. `Footer.css` is kept only for the `a:hover` rule, which needs a
// real stylesheet (no inline equivalent for pseudo-classes).
const FOOTER_STYLE = {
  width: "100%",
  padding: "24px 16px 32px",
  boxSizing: "border-box",
};

const CONTENT_STYLE = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "8px",
  fontSize: "13px",
  color: "#616161",
  textAlign: "center",
};

const LINK_STYLE = {
  color: "#005bd3",
  textDecoration: "underline",
};

const DIVIDER_STYLE = {
  color: "#8c9196",
};

export default function Footer() {
  const t = useTranslation();

  return (
    <s-page>
      <footer className="mag-app-footer" style={FOOTER_STYLE}>
        <div className="mag-app-footer-content" style={CONTENT_STYLE}>
          <span>{t("footer.copyright")}</span>

          <span className="mag-footer-divider" style={DIVIDER_STYLE}>
            |
          </span>

          <a
            href="https://www.myappgurus.com/policies/privacy-policy"
            target="_blank"
            rel="noreferrer"
            style={LINK_STYLE}
          >
            {t("footer.privacyPolicy")}
          </a>

          <span className="mag-footer-divider" style={DIVIDER_STYLE}>
            |
          </span>

          <a
            href="https://www.myappgurus.com/policies/terms-of-service"
            target="_blank"
            rel="noreferrer"
            style={LINK_STYLE}
          >
            {t("footer.termsOfService")}
          </a>
        </div>
      </footer>
    </s-page>
  );
}