import { useEffect } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";
import { LocaleProvider } from "./locales/translation";
import { getPreferredLocale, getMessages } from "./locales";

function useWebVitalsLogger() {
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const lastEntry = entries[entries.length - 1];
      // eslint-disable-next-line no-console
      console.log(
        `[Web Vitals] LCP: ${lastEntry.startTime.toFixed(2)}ms`,
        lastEntry,
      );
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });

    let clsValue = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
          // eslint-disable-next-line no-console
          console.log(`[Web Vitals] CLS: ${clsValue.toFixed(4)}`, entry);
        }
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });

    return () => {
      lcpObserver.disconnect();
      clsObserver.disconnect();
    };
  }, []);
}

export const loader = async ({ request }) => {
  const acceptLanguage = request.headers.get("accept-language");
  const locale = getPreferredLocale(acceptLanguage);
  return { locale, messages: getMessages(locale) };
};

export default function App() {
  const { locale, messages } = useLoaderData();

  useWebVitalsLogger();

  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <LocaleProvider locale={locale} messages={messages}>
          <Outlet />
        </LocaleProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
