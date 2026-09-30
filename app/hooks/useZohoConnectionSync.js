import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";

function toast(message, isError = false) {
  try {
    window.shopify?.toast?.show(message, { isError });
  } catch {
    // App Bridge not ready - the page still revalidates below.
  }
}

export function useZohoConnectionSync() {
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const connectFetcher = useFetcher();
  const connectFetcherRef = useRef(connectFetcher);
  connectFetcherRef.current = connectFetcher;

  // The OAuth popup hands the authorization code back to this window; the
  // authenticated /app/zoho-connect action completes the exchange.
  useEffect(() => {
    if (connectFetcher.state !== "idle" || !connectFetcher.data) return;
    if (connectFetcher.data.ok) {
      toast(`Connected to Zoho Books${connectFetcher.data.organizationName ? ` (${connectFetcher.data.organizationName})` : ""}`);
    } else {
      toast(connectFetcher.data.error || "Failed to connect Zoho Books", true);
    }
  }, [connectFetcher.state, connectFetcher.data]);

  useEffect(() => {
    function handleMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.source !== "zoho-oauth") return;
      if (event.data.type === "authorization-code") {
        const { code, state, accountsServer } = event.data;
        if (typeof code !== "string" || typeof state !== "string") return;
        const formData = { code, state };
        if (typeof accountsServer === "string" && accountsServer) formData.accountsServer = accountsServer;
        connectFetcherRef.current.submit(formData, { method: "post", action: "/app/zoho-connect" });
        return;
      }
      revalidatorRef.current.revalidate();
    }

    const styleId = "zoho-settings-interaction-fixes";
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .sync-icon.purple { position:relative; overflow:hidden; }
        .sync-icon.purple s-icon[type="customer"] { display:none; }
        .sync-icon.purple::before { content:"";position:absolute;width:7px;height:7px;border-radius:50%;background:currentColor;top:6px;left:50%;transform:translateX(-50%); }
        .sync-icon.purple::after { content:"";position:absolute;width:14px;height:8px;border-radius:9px 9px 4px 4px;background:currentColor;left:50%;bottom:5px;transform:translateX(-50%); }

        /* Tax Settings controls */
        .tax-field { display:flex; align-items:center; gap:12px; min-width:0; }
        .tax-field label { margin:0; color:#24385d; font-size:12px; line-height:18px; font-weight:600; white-space:nowrap; }
        .tax-field select { width:270px; max-width:100%; height:40px; box-sizing:border-box; border:1px solid #cfd9e8; border-radius:7px; background-color:#fff; color:#17233c; padding:0 36px 0 12px; font-size:12px; line-height:40px; font-family:inherit; cursor:pointer; outline:none; appearance:none; -webkit-appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23526783' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 11px center; background-size:14px 14px; transition:border-color .15s ease, box-shadow .15s ease; }
        .tax-field select:hover { border-color:#aebdd2; }
        .tax-field select:focus { border-color:#1264ed; box-shadow:0 0 0 2px rgba(18,100,237,.12); }
        .tax-field select:disabled { background-color:#f8fafc; color:#66758f; cursor:not-allowed; }

        .tax-table-row { position:relative; }
        .tax-action-wrap { position:relative; display:flex; justify-content:flex-end; align-items:center; }
        .tax-action-menu { position:absolute; right:0; top:34px; z-index:100; min-width:145px; padding:5px; border:1px solid #d8e0ed; border-radius:8px; background:#fff; box-shadow:0 10px 28px rgba(20,35,60,.16); }
        .tax-action-menu button { width:100%; border:0; background:#fff; border-radius:6px; padding:8px 10px; text-align:left; color:#24385d; font-size:11px; cursor:pointer; }
        .tax-action-menu button:hover { background:#edf5ff; color:#1264ed; }
        .tax-custom-row { background:#fbfdff; }
        .tax-custom-row strong { color:#1264ed; }

        @media(max-width:650px) {
          .tax-field { align-items:flex-start; flex-direction:column; gap:7px; }
          .tax-field select { width:100%; }
        }
      `;
      document.head.appendChild(style);
    }

    function updateTaxStatus(row) {
      const select = row?.querySelector(".tax-select");
      const status = row?.querySelector(".tax-status");
      if (!select || !status) return;
      const mapped = Boolean(select.value);
      status.className = `tax-status ${mapped ? "mapped" : "unmapped"}`;
      status.textContent = mapped ? "Mapped" : "Not mapped";
    }

    function closeTaxMenus(except) {
      document.querySelectorAll(".tax-action-menu").forEach((menu) => {
        if (menu !== except) menu.remove();
      });
    }

    function addCustomTaxMapping() {
      const table = document.querySelector(".tax-table");
      if (!table) return;
      const existing = table.querySelector(".tax-custom-row");
      if (existing) {
        existing.querySelector(".tax-select")?.focus();
        return;
      }

      const sourceSelect = table.querySelector(".tax-table-row .tax-select");
      if (!sourceSelect) return;

      const key = `custom_${Date.now()}`;
      const row = document.createElement("div");
      row.className = "tax-table-row tax-custom-row";
      row.innerHTML = `
        <strong>Custom Tax Mapping</strong>
        <span class="tax-code">CUSTOM-TAX</span>
        <select class="tax-select" name="taxrate:${key}"></select>
        <span class="tax-type">Goods &amp; Services Tax</span>
        <span class="tax-status unmapped">Not mapped</span>
        <div class="tax-action-wrap"><button class="tax-action" type="button" aria-label="Actions for Custom Tax Mapping">⋮</button></div>
      `;

      const select = row.querySelector(".tax-select");
      Array.from(sourceSelect.options).forEach((option) => select.appendChild(option.cloneNode(true)));
      table.appendChild(row);
      select.addEventListener("change", () => updateTaxStatus(row));
      select.focus();
    }

    function openTaxAction(row, button) {
      closeTaxMenus();
      const wrap = button.closest(".tax-action-wrap") || button.parentElement;
      if (!wrap) return;
      const menu = document.createElement("div");
      menu.className = "tax-action-menu";
      menu.innerHTML = `
        <button type="button" data-tax-action="clear">Clear Mapping</button>
        ${row.classList.contains("tax-custom-row") ? '<button type="button" data-tax-action="remove">Remove Mapping</button>' : ""}
      `;
      wrap.appendChild(menu);

      menu.querySelector('[data-tax-action="clear"]')?.addEventListener("click", () => {
        const select = row.querySelector(".tax-select");
        if (select) {
          select.value = "";
          updateTaxStatus(row);
        }
        menu.remove();
      });

      menu.querySelector('[data-tax-action="remove"]')?.addEventListener("click", () => {
        row.remove();
        menu.remove();
      });
    }

    function handleTaxClick(event) {
      const add = event.target.closest(".tax-add");
      if (add) {
        event.preventDefault();
        event.stopPropagation();
        addCustomTaxMapping();
        return;
      }

      const action = event.target.closest(".tax-action");
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        const row = action.closest(".tax-table-row");
        if (row) openTaxAction(row, action);
        return;
      }

      if (!event.target.closest(".tax-action-menu")) closeTaxMenus();
    }

    function handleTaxChange(event) {
      const select = event.target.closest(".tax-table-row .tax-select");
      if (!select) return;
      updateTaxStatus(select.closest(".tax-table-row"));
    }

    document.addEventListener("click", handleTaxClick, true);
    document.addEventListener("change", handleTaxChange, true);
    window.addEventListener("message", handleMessage);

    return () => {
      document.removeEventListener("click", handleTaxClick, true);
      document.removeEventListener("change", handleTaxChange, true);
      window.removeEventListener("message", handleMessage);
      style?.remove();
    };
  }, []);
}
