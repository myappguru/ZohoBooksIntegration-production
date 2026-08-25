const defaultLocale = "en";

const baseMessages = {
  "app.title": "MAG: Zoho Books Integration",
  "app.nav.dashboard": "Dashboard",
  "app.nav.products": "Products",
  "app.nav.customers": "Customers",
  "app.nav.orders": "Orders",
  "app.nav.inventory": "Inventory",
  "app.nav.syncHistory": "Reporting",
  "app.nav.settings": "Settings",
  "app.nav.helpSupport": "Help & Support",
  "helpSupport.title": "Help & Support",
  "helpSupport.contactUs.title": "Contact Support",
  "helpSupport.contactUs.body": "Need help with the app? Start a chat or send us an email and we’ll get back to you shortly.",
  "helpSupport.contactUs.btn1": "Chat with support",
  "helpSupport.contactUs.btn2": "Email support",
  "helpSupport.rateApp.title": "Rate our app",
  "helpSupport.rateApp.body": "If you’re enjoying MAG: Zoho Books Integration, please leave us a review on the Shopify App Store.",
  "helpSupport.rateApp.btn": "Leave a review",
  "helpSupport.dismiss": "Dismiss",
  "dashboard.mainHeading": "Shopify → Zoho Books",
  "dashboard.subtitle": "Connect your Shopify store with Zoho Books and manage your data synchronization from one place.",
  "dashboard.connections": "Connections",
  "dashboard.shopifyStore": "Shopify Store",
  "dashboard.connected": "Connected",
  "dashboard.shopifyConnectedDescription": "Your Shopify store is connected to MAG.",
  "dashboard.zohoBooks": "Zoho Books",
  "dashboard.notConnected": "Not Connected",
  "dashboard.zohoConnectDescription": "Connect your Zoho Books organization to start synchronizing your Shopify data.",
  "dashboard.zohoConnectedDescriptionPrefix": "Connected to organization: ",
  "dashboard.connectZohoButton": "Connect Zoho Books",
  "dashboard.syncOverview": "Synchronization Overview",
  "dashboard.products": "Products",
  "dashboard.customers": "Customers",
  "dashboard.orders": "Orders",
  "dashboard.inventory": "Inventory",
  "dashboard.notSynced": "Not synced",
  "dashboard.recentActivity": "Recent Sync Activity",
  "dashboard.noSyncYet": "No synchronization has been performed yet.",
  "dashboard.syncNow": "Sync Now",
  "otherApps.moreFrom": "Boost your growth with MyAppGurus apps.",
  "otherApps.description": "Explore apps that optimize your store, simplify operations, and drive more sales.",
  "otherApps.app1.name": "MAG: Form Builder",
  "otherApps.app1.description": "Simplify lead generation with user-friendly forms.",
  "otherApps.app2.name": "Multi Wishlist - MyAppGurus",
  "otherApps.app2.description": "Increase customer engagement and sales through beautiful wishlists.",
  "otherApps.app3.name": "MAG: Upsell + Cross-sell",
  "otherApps.app3.description": "Encourage more purchases with targeted upsells and cross-sells.",
  "otherApps.app4.name": "MAG: Product Reviews",
  "otherApps.app4.description": "Build trust and loyalty through reviews and customized offers",
  "otherApps.app5.name": "Event Management‑MyAppGurus",
  "otherApps.app5.description": "Streamline your event planning and boost attendance.",
  "otherApps.getApp": "Get App",
  "otherApps.slidePrevious": "Previous apps",
  "otherApps.slideNext": "Next apps",
  "footer.copyright": "© 2026 MyAppGurus. All Rights Reserved.",
  "footer.privacyPolicy": "Privacy Policy",
  "footer.termsOfService": "Terms of Service",
  "login.pageTitle": "Log in",
  "login.shopDomain": "Shop domain",
  "login.shopDetails": "example.myshopify.com",
  "login.submit": "Log in",
  "login.error.missingShop": "Please enter your shop domain to log in",
  "login.error.invalidShop": "Please enter a valid shop domain to log in",
  "landing.heading": "A short heading about [your app]",
  "landing.subheading": "A tagline about [your app] that describes your value proposition.",
  "landing.productFeature": "Product feature",
  "landing.productFeatureDetail": "Some detail about your feature and its benefit to your customer.",
  "landing.shopDomain": "Shop domain",
  "landing.shopExample": "e.g: my-shop-domain.myshopify.com",
  "landing.loginButton": "Log in",
  "home.link": "Home",
  "welcome.title": "Welcome",
  "welcome.heading": "Welcome to MAG : Zoho Book Integration",
  "welcome.description1": "This app connects your Shopify store with Zoho Books, keeping your orders, customers, and invoices in sync automatically.",
  "welcome.description2.start": "Use the navigation above to explore the app. Head to the ",
  "welcome.description2.end": " page to get started.",
  "welcome.gettingStarted": "Getting started",
  "welcome.list.connectZoho": "Connect your Zoho Books account",
  "welcome.list.reviewSettings": "Review your sync settings",
  "welcome.list.checkDashboard": "Check the sync status dashboard"
};

const locales = {
  cs: baseMessages,
  da: baseMessages,
  de: baseMessages,
  en: baseMessages,
  es: baseMessages,
  fi: baseMessages,
  fr: baseMessages,
  it: baseMessages,
  ja: baseMessages,
  ko: baseMessages,
  nb: baseMessages,
  nl: baseMessages,
  pl: baseMessages,
  "pt-BR": baseMessages,
  "pt-PT": baseMessages,
  sv: baseMessages,
  th: baseMessages,
  tr: baseMessages,
  "zh-CN": baseMessages,
  "zh-TW": baseMessages,
};

const aliases = {
  "pt_br": "pt-BR",
  "pt_pt": "pt-PT",
  "pt-br": "pt-BR",
  "pt-pt": "pt-PT",
  "zh_cn": "zh-CN",
  "zh_tw": "zh-TW",
  "zh-tw": "zh-TW",
  "nb_no": "nb",
};

function normalizeLocale(value) {
  if (!value) return defaultLocale;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return aliases[normalized] || normalized;
}

export function getPreferredLocale(acceptLanguageHeader) {
  if (!acceptLanguageHeader) return defaultLocale;

  const candidates = acceptLanguageHeader
    .split(",")
    .map((part) => {
      const [lang, qValue] = part.trim().split(";");
      const q = qValue && qValue.startsWith("q=") ? parseFloat(qValue.slice(2)) : 1;
      return { lang, q };
    })
    .sort((a, b) => b.q - a.q)
    .map((entry) => normalizeLocale(entry.lang));

  for (const locale of candidates) {
    if (locales[locale]) return locale;
    const base = locale.split("-")[0];
    if (locales[base]) return base;
  }

  return defaultLocale;
}

export function getMessages(locale) {
  return locales[locale] || locales[defaultLocale];
}

export const supportedLocales = Object.keys(locales);
export { defaultLocale };
