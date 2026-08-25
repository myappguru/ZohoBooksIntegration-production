import { createContext, useContext } from "react";

const LocaleContext = createContext({ locale: "en", messages: {} });

export function LocaleProvider({ locale, messages, children }) {
  return (
    <LocaleContext.Provider value={{ locale, messages }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useTranslation must be used within a LocaleProvider");
  }

  return (key) => context.messages[key] || key;
}
