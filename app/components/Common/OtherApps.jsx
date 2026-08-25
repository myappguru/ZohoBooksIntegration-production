import { useTranslation } from "../../locales/translation";
import { useEffect, useRef, useState } from "react";
import "./OtherApps.css";

// The external stylesheet's structural rules (flex row, card border/
// background/padding) stopped visibly applying in this environment for
// reasons that couldn't be confirmed from here (not a code content issue -
// the file and class names both check out; something in the page's actual
// CSS loading/cascade isn't giving these classes effect). Duplicating the
// critical layout as inline styles sidesteps that entirely, since inline
// `style` wins over any external stylesheet rule regardless of load order
// or specificity. `OtherApps.css` is kept only for the ::-webkit-scrollbar
// hiding rules, which can't be expressed as an inline style.
const WRAPPER_STYLE = { position: "relative" };

const SLIDER_STYLE = {
  display: "flex",
  alignItems: "flex-start",
  gap: "12px",
  width: "100%",
  overflowX: "auto",
  paddingBottom: "4px",
  scrollSnapType: "x mandatory",
  scrollbarWidth: "none",
};

// Sized/spaced to match the reference design the user shared (Shopify's own
// native "Boost your growth" app-recommendation widget).
//
// `<s-thumbnail>`'s `size` prop is a fixed token, not a percentage of its
// container - confirmed against the real component schema (`"base" |
// "small" | "small-200" | "small-100" | "large" | "large-100"`). Padding on
// this wrapper doesn't shrink the rendered image at all when `size="large"`
// is bigger than the wrapper: it just crops more of an already-oversized
// image, so the visible portion still touches every edge (no margin ever
// appears, since there was never a size deficit to center). The actual fix
// is using a smaller `size` token (see the JSX below, now "base" instead of
// "large") so the image is genuinely smaller than the 64x64 frame, letting
// real margin show around it.
const ICON_STYLE = {
  width: "64px",
  height: "64px",
  borderRadius: "14px",
  overflow: "hidden",
};

// Cards per view at various container widths - a JS-computed replacement
// for the CSS file's `@media` breakpoints, since those are just as
// vulnerable to whatever is suppressing the rest of this stylesheet.
function cardsPerViewFor(width) {
  if (width < 550) return 1.25;
  if (width < 800) return 2;
  // 3.5 (not a clean 3) is intentional - a partial card peeking at the edge
  // signals there's more to scroll to. The embedded admin's actual content
  // area is narrower than a raw browser window, so this used to require
  // 1100px+ to trigger and never showed the peek in practice - lowered the
  // threshold so it's the default for any reasonably wide view.
  return 3.5;
}

function cardStyleFor(cardsPerView) {
  const gapCount = Math.max(Math.ceil(cardsPerView) - 1, 1);
  return {
    flex: `0 0 calc((100% - ${gapCount * 12}px) / ${cardsPerView})`,
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    gap: "16px",
    minWidth: "280px",
    scrollSnapAlign: "start",
    padding: "16px",
    border: "1px solid #d1d5db",
    borderRadius: "12px",
    background: "#ffffff",
    boxSizing: "border-box",
  };
}

const apps = [
  {
    key: "app1",
    icon: "https://cdn.shopify.com/app-store/listing_images/37265693174da884e4e6dc368de9dab7/icon/CP_9pp3CnIkDEAE=.png?height=72&quality=90&width=72",
    url: "https://apps.shopify.com/form-builder-myappgurus",
  },
  {
    key: "app2",
    icon: "https://cdn.shopify.com/app-store/listing_images/df79bafb0a63a5582508b660b89dca1d/icon/CNHJjPmEjf4CEAE=.jpeg?height=72&quality=90&width=72",
    url: "https://apps.shopify.com/wishlist-myappgurus",
  },
  {
    key: "app3",
    icon: "https://cdn.shopify.com/app-store/listing_images/eafd81a81170514e1ea406f20a50bc8a/icon/CMXD5dWfvI4DEAE=.png?height=72&quality=90&width=72",
    url: "https://apps.shopify.com/mag-upsell-crosssell",
  },
  {
    key: "app4",
    icon: "https://cdn.shopify.com/app-store/listing_images/772b08d7aeeedd29dda48e1bbf1918bd/icon/CL2ZuMKHpv4CEAE=.jpeg?height=72&quality=90&width=72",
    url: "https://apps.shopify.com/product-review-myappgurus",
  },
  {
    key: "app5",
    icon: "https://cdn.shopify.com/app-store/listing_images/947d6a4310b97ac2993be68dcede3182/icon/CL20s_-Jtv4CEAE=.jpeg?height=72&quality=90&width=72",
    url: "https://apps.shopify.com/event-management-myappgurus",
  },
];

export default function OtherApps() {
  const t = useTranslation();
  const sliderRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [cardsPerView, setCardsPerView] = useState(3.5);

  const updateSliderControls = () => {
    const slider = sliderRef.current;
    if (!slider) return;

    setCanScrollLeft(slider.scrollLeft > 0);
    setCanScrollRight(
      slider.scrollLeft + slider.clientWidth < slider.scrollWidth - 1,
    );
    setCardsPerView(cardsPerViewFor(slider.clientWidth));
  };

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;

    // A single measurement right after mount isn't reliable here - this
    // component sits inside `<s-section>` (a Polaris web component), and its
    // internal layout/slotting can still be settling at the exact moment
    // this effect first runs, so `scrollWidth`/`clientWidth` can be read
    // before the row of cards has its final size. That left both arrows
    // permanently stuck disabled even with clearly more than 3 cards
    // visible, since nothing re-checked afterward except a browser window
    // resize. `ResizeObserver` re-measures whenever the slider's own box
    // actually settles or changes, not just on window resize.
    updateSliderControls();
    const observer = new ResizeObserver(() => updateSliderControls());
    observer.observe(slider);

    return () => observer.disconnect();
  }, []);

  const scrollSlider = (direction) => {
    const slider = sliderRef.current;
    if (!slider) return;

    const offset = Math.round(slider.clientWidth * 0.75);
    slider.scrollBy({ left: direction * offset, behavior: "smooth" });
  };

  return (
    <s-section>
      <s-stack gap="large">
        <s-stack
          direction="inline"
          justifyContent="space-between"
          alignItems="center"
          gap="large"
        >
          <s-stack gap="small-100">
            <s-heading>{t("otherApps.moreFrom")}</s-heading>

            <s-text color="subdued">{t("otherApps.description")}</s-text>
          </s-stack>

          <s-stack direction="inline" gap="small">
            <s-button
              icon="chevron-left"
              accessibilityLabel={t("otherApps.slidePrevious")}
              onClick={() => scrollSlider(-1)}
              disabled={!canScrollLeft}
            ></s-button>
            <s-button
              icon="chevron-right"
              accessibilityLabel={t("otherApps.slideNext")}
              onClick={() => scrollSlider(1)}
              disabled={!canScrollRight}
            ></s-button>
          </s-stack>
        </s-stack>

        <div className="mag-other-app-wrapper" style={WRAPPER_STYLE}>
          <div
            className="mag-other-apps"
            style={SLIDER_STYLE}
            ref={sliderRef}
            onScroll={updateSliderControls}
          >
            {apps.map((app) => (
              <div
                className="mag-other-app-card"
                style={cardStyleFor(cardsPerView)}
                key={app.key}
              >
                <s-stack gap="base">
                  <div className="mag-other-app-icon" style={ICON_STYLE}>
                    <s-thumbnail
                      src={app.icon}
                      alt={`${t(`otherApps.${app.key}.name`)} icon`}
                      size="base"
                    ></s-thumbnail>
                  </div>

                  <s-stack gap="small-100">
                    <s-text type="strong">
                      {t(`otherApps.${app.key}.name`)}
                    </s-text>

                    <s-text color="subdued">
                      {t(`otherApps.${app.key}.description`)}
                    </s-text>
                  </s-stack>
                </s-stack>

                <s-box inlineSize="100%">
                  <s-button icon="export" href={app.url} target="_blank">
                    {t("otherApps.getApp")}
                  </s-button>
                </s-box>
              </div>
            ))}
          </div>
        </div>
      </s-stack>
    </s-section>
  );
}
