import db from "../db.server";
import {
  createZohoSalesOrder,
  updateZohoSalesOrder,
  voidZohoSalesOrder,
} from "../zoho.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "./zohoConnection.server";
import { getAppSettings } from "./appSettings.server";
import { syncVariantToZoho, getProductMappings } from "./productSync.server";
import { syncCustomerToZoho, getCustomerMappings } from "./customerSync.server";
import { recordWebhookReceived, finishWebhookLog } from "./webhookLog.server";
import { startSyncLog, finishSyncLog } from "./syncLog.server";

const ENTITY_TYPE = "order";

// Used by the Dashboard's "Synchronization Overview" stat tile.
export async function getSyncedOrderCount(shopId) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS count FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND status = 'synced'`,
    [shopId, ENTITY_TYPE],
  );

  return rows[0]?.count || 0;
}

// ZohoApiError's `.message` is just a generic label ("Failed to update Zoho
// sales order") - the actual reason Zoho gave lives in `.details`. Folding
// it into the stored string means the real cause shows up in sync_mappings
// / sync_logs directly, instead of only being visible in server console logs.
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

export async function getOrderMappings(shopId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id, status, last_synced_at, last_error FROM sync_mappings WHERE shop_id = ? AND entity_type = ?`,
    [shopId, ENTITY_TYPE],
  );

  return Object.fromEntries(
    rows.map((row) => [
      row.shopify_id,
      {
        zohoId: row.zoho_id,
        status: row.status,
        lastSyncedAt: row.last_synced_at,
        lastError: row.last_error,
      },
    ]),
  );
}

export async function getOrderMapping(shopId, shopifyOrderId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyOrderId],
  );

  return rows[0] || null;
}

export async function saveOrderMapping(shopId, shopifyOrderId, zohoSalesOrderId) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, 'synced', NOW(), NULL)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), status = 'synced', last_synced_at = NOW(), last_error = NULL`,
    [shopId, ENTITY_TYPE, shopifyOrderId, zohoSalesOrderId],
  );
}

export async function markOrderMappingError(shopId, shopifyOrderId, errorMessage) {
  await db.execute(
    `UPDATE sync_mappings SET status = 'error', last_error = ? WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [errorMessage, shopId, ENTITY_TYPE, shopifyOrderId],
  );
}

export async function markOrderMappingVoided(shopId, shopifyOrderId) {
  await db.execute(
    `UPDATE sync_mappings SET status = 'voided', last_error = NULL WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyOrderId],
  );
}

// An order's contact is its Shopify customer record when one exists: same
// shape customerSync.server.js expects. Guest checkouts (no linked customer
// account) still carry an email/billing address on the order itself, so a
// synthetic id ("guest:<email>") is used as the sync_mappings key - this
// keeps repeat orders from the same guest email linking to the one Zoho
// contact instead of creating a duplicate every time.
export function buildOrderCustomer(order) {
  if (order.customer) return order.customer;

  const billing = order.billingAddress || {};
  if (!order.email) return { id: null, email: null };

  return {
    id: `guest:${order.email}`,
    firstName: billing.firstName || "",
    lastName: billing.lastName || "",
    email: order.email,
    phone: order.phone || billing.phone || "",
    address: {
      address1: billing.address1 || "",
      address2: billing.address2 || "",
      city: billing.city || "",
      province: billing.province || "",
      zip: billing.zip || "",
      country: billing.country || "",
      phone: billing.phone || "",
    },
  };
}

function formatZohoDate(isoDate) {
  return (isoDate || "").slice(0, 10) || undefined;
}

// Shopify can apply more than one tax line to a single item (e.g. India's
// CGST+SGST split instead of one combined rate) - Zoho's line item only
// takes a single tax_id, so a compound Shopify rate is expected to be
// mapped to one Zoho tax (a plain tax or a Zoho "tax group" covering the
// same combination). The key has to be stable regardless of the array's
// order, since Shopify doesn't guarantee a fixed ordering of tax lines.
export function buildTaxRateKey(taxLines) {
  if (!taxLines?.length) return null;

  return taxLines
    .map((line) => `${line.title}@${Number(line.rate || 0).toFixed(4)}`)
    .sort()
    .join("+");
}

export function buildTaxRateLabel(taxLines) {
  if (!taxLines?.length) return null;

  return taxLines
    .map((line) => `${line.title} (${(Number(line.rate || 0) * 100).toFixed(2)}%)`)
    .join(" + ");
}

// Falls back to the shop's single "default tax" (Settings > Tax settings)
// for any rate combination that hasn't been explicitly mapped yet - this is
// what every order already did before per-rate mapping existed, so an
// unmapped rate degrades to the old behavior instead of syncing untaxed.
function resolveLineItemTaxId(taxLines, rateMap, defaultTaxId) {
  const key = buildTaxRateKey(taxLines);
  const mapped = key ? rateMap?.[key] : null;

  return mapped || defaultTaxId || null;
}

function buildOrderNotes(order) {
  const parts = [];
  if (order.note) parts.push(order.note);
  if (order.discountCodes?.length) {
    parts.push(`Coupon code(s): ${order.discountCodes.join(", ")}`);
  }
  return parts.join("\n") || undefined;
}

// `lineItems` here are already-resolved { zohoItemId, quantity, price,
// taxLines } - see resolveOrderLineItems. `taxSettings` is the shop's saved
// { defaultTaxId, pricesIncludeTax, discountBeforeTax, rateMap } from the
// Settings page - `rateMap` maps a Shopify tax-rate key (buildTaxRateKey)
// to a specific Zoho tax_id, so different items taxed at different
// rates/regions each get their own correct Zoho tax rather than one
// blanket default. Zoho has no equivalent field to tax the shipping
// charge itself (confirmed against Zoho's Sales Order/Invoice API docs -
// shipping_charge is just a flat number with no shipping_charge_tax_id),
// so shipping tax isn't itemized here; it rides along inside whatever
// totalShipping already reflects. `order.shippingMethod` (the checkout-time
// shipping rate name, e.g. "Standard Shipping") maps to the sales order's
// own `delivery_method` field - distinct from the Shipment Order's
// delivery_method set later in fulfillmentSync.server.js, which records the
// actual carrier used once the order ships, not what the customer selected.
export function buildZohoSalesOrderPayload(order, { customerId, lineItems, taxSettings }) {
  return {
    customer_id: customerId,
    date: formatZohoDate(order.createdAt),
    reference_number: order.name,
    is_inclusive_tax: Boolean(taxSettings?.pricesIncludeTax),
    discount: Number(order.totalDiscount) || 0,
    discount_type: "entity_level",
    is_discount_before_tax: taxSettings?.discountBeforeTax !== false,
    shipping_charge: Number(order.totalShipping) || 0,
    ...(order.shippingMethod ? { delivery_method: order.shippingMethod } : {}),
    notes: buildOrderNotes(order),
    line_items: lineItems.map((lineItem) => {
      const taxId = resolveLineItemTaxId(
        lineItem.taxLines,
        taxSettings?.rateMap,
        taxSettings?.defaultTaxId,
      );

      return {
        item_id: lineItem.zohoItemId,
        quantity: lineItem.quantity,
        rate: Number(lineItem.price) || 0,
        ...(taxId ? { tax_id: taxId } : {}),
      };
    }),
  };
}

// Resolves each order line item to a Zoho item_id, auto-syncing the
// variant on the spot (via the exact same syncVariantToZoho used by
// product sync) if it hasn't been synced yet - an order shouldn't have to
// wait on someone visiting the Products page first. Line items without a
// SKU or a real variant (custom/manual line items) are skipped, same as
// product sync skips variants without a SKU.
async function resolveOrderLineItems({ shopId, admin, zohoAuth, order, productMappings, inventoryAccountId }) {
  const resolved = [];

  for (const lineItem of order.lineItems) {
    if (!lineItem.sku || !lineItem.variantId) continue;

    const existingZohoItemId = productMappings[lineItem.variantId]?.zohoId;

    if (existingZohoItemId) {
      // Already linked - reuse it as-is rather than calling
      // syncVariantToZoho again. An order's line item only carries
      // `lineItem.title` (no separate product/variant title), so
      // reconstructing a synthetic product+variant pair from it and
      // updating the Zoho item would rename it using that duplicated
      // title (e.g. "X - X" instead of the item's real "X - Special X") -
      // confirmed live to collide with a differently-named existing item
      // and fail with Zoho error 1001 ("Item already exists"). It would
      // also silently overwrite the item's catalog rate with this one
      // order's line item price. Order sync only needs the link, not a
      // second, worse source of truth for the item's own fields - the
      // Products page already owns keeping name/price accurate.
      resolved.push({
        zohoItemId: existingZohoItemId,
        quantity: lineItem.quantity,
        price: lineItem.price,
        taxLines: lineItem.taxLines,
      });
      continue;
    }

    const variant = {
      id: lineItem.variantId,
      title: lineItem.title,
      sku: lineItem.sku,
      price: lineItem.price,
    };
    const product = {
      id: lineItem.productId || null,
      title: lineItem.title,
      status: "ACTIVE",
      description: "",
    };

    const result = await syncVariantToZoho({
      shopId,
      admin,
      zohoAuth,
      product,
      variant,
      mappings: productMappings,
      inventoryAccountId,
    });

    if (result.status === "success") {
      resolved.push({
        zohoItemId: result.zohoItemId,
        quantity: lineItem.quantity,
        price: lineItem.price,
        taxLines: lineItem.taxLines,
      });
    }
  }

  return resolved;
}

// `order` is { id, name, createdAt, email, phone, customer, billingAddress,
// lineItems: [{ variantId, productId, sku, title, quantity, price }],
// totalDiscount, totalShipping, totalTax, note, discountCodes } - the same
// shape whether it came from the Admin GraphQL orders query or was
// normalized from a REST webhook payload.
// `admin` is optional (only passed by the direct "Sync now"/"Sync
// everything" call path, which has it readily available) - it's only used
// to also enforce oversell prevention on any variant discovered for the
// first time via an order's line items (see denyOversellForVariant in
// productSync.server.js). Webhook/invoice-triggered call sites don't pass
// it, which just means that one thin edge case (a brand-new variant seen
// only through an order webhook, never through product sync) doesn't get
// the policy enforced immediately - it still will next time a product sync
// touches that variant.
export async function syncOrderToZoho({
  shopId,
  admin,
  zohoAuth,
  order,
  taxSettings,
  productMappings,
  customerMappings,
  orderMappings,
  inventoryAccountId,
}) {
  const customer = buildOrderCustomer(order);
  if (!customer.email) {
    return { orderName: order.name, status: "skipped" };
  }

  const customerResult = await syncCustomerToZoho({
    shopId,
    zohoAuth,
    customer,
    mappings: customerMappings,
  });
  if (customerResult.status === "error") {
    await markOrderMappingError(shopId, order.id, `Customer sync failed: ${customerResult.error}`);
    return { orderName: order.name, status: "error", error: `customer: ${customerResult.error}` };
  }

  const lineItems = await resolveOrderLineItems({
    shopId,
    admin,
    zohoAuth,
    order,
    productMappings,
    inventoryAccountId,
  });
  if (lineItems.length === 0) {
    return { orderName: order.name, status: "skipped" };
  }

  const payload = buildZohoSalesOrderPayload(order, {
    customerId: customerResult.zohoContactId,
    lineItems,
    taxSettings,
  });
  const existingMapping = orderMappings[order.id];

  try {
    let zohoSalesOrderId = existingMapping?.zohoId;

    if (zohoSalesOrderId) {
      await updateZohoSalesOrder(zohoAuth, zohoSalesOrderId, payload);
    } else {
      const created = await createZohoSalesOrder(zohoAuth, payload);
      zohoSalesOrderId = created.salesorder_id;
    }

    await saveOrderMapping(shopId, order.id, zohoSalesOrderId);

    return { orderName: order.name, zohoSalesOrderId, status: "success" };
  } catch (error) {
    // Zoho locks a sales order's line items from further edits once it's
    // been invoiced (error 36023) - that's an expected terminal state once
    // Section E has run, not a real sync failure, so the existing mapping
    // is left as-is (still "synced") rather than overwritten with "error".
    if (existingMapping?.zohoId && error.details?.code === 36023) {
      await saveOrderMapping(shopId, order.id, existingMapping.zohoId);
      return { orderName: order.name, zohoSalesOrderId: existingMapping.zohoId, status: "success" };
    }

    // Zoho rejects a `tax_id` on ANY line item, org-wide, if GST hasn't been
    // enabled under that org's own Zoho Books Tax Settings (error 110942) -
    // confirmed live (2026-08-18) to fail the *entire* update, not just the
    // tax portion, which would otherwise mean a shop with an incomplete/
    // stale tax rate mapping loses shipping method/discount/line-item sync
    // too, a worse regression than before Section J existed (previously no
    // tax_id was ever sent, so this failure mode couldn't happen at all).
    // Retry once with every line item's tax_id stripped, so the rest of the
    // order still syncs - this is an org-configuration gap for the
    // merchant to fix in Zoho's own UI, not something worth hard-failing
    // the whole sync over.
    if (error.details?.code === 110942) {
      const untaxedPayload = {
        ...payload,
        // eslint-disable-next-line no-unused-vars -- destructuring tax_id out is how it's dropped from `rest`
        line_items: payload.line_items.map(({ tax_id, ...rest }) => rest),
      };

      try {
        let zohoSalesOrderId = existingMapping?.zohoId;

        if (zohoSalesOrderId) {
          await updateZohoSalesOrder(zohoAuth, zohoSalesOrderId, untaxedPayload);
        } else {
          const created = await createZohoSalesOrder(zohoAuth, untaxedPayload);
          zohoSalesOrderId = created.salesorder_id;
        }

        await saveOrderMapping(shopId, order.id, zohoSalesOrderId);

        return { orderName: order.name, zohoSalesOrderId, status: "success" };
      } catch (retryError) {
        console.error("Failed to sync order to Zoho even without tax_id", order.name, retryError);
        const description = describeZohoError(retryError);
        await markOrderMappingError(shopId, order.id, description);

        return { orderName: order.name, status: "error", error: description };
      }
    }

    console.error("Failed to sync order to Zoho", order.name, error);
    const description = describeZohoError(error);
    await markOrderMappingError(shopId, order.id, description);

    return { orderName: order.name, status: "error", error: description };
  }
}

// Shared by `app.orders.jsx`'s loader (paginated display) and the
// sync-all/sync-now helpers below.
export const ORDERS_QUERY = `#graphql
  query SyncableOrders($first: Int, $after: String, $last: Int, $before: String) {
    orders(first: $first, after: $after, last: $last, before: $before, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          updatedAt
          email
          phone
          displayFinancialStatus
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          paymentGatewayNames
          customer {
            id
            firstName
            lastName
            email
            phone
            defaultAddress {
              address1
              address2
              city
              province
              zip
              country
              phone
            }
          }
          billingAddress {
            firstName
            lastName
            address1
            address2
            city
            province
            zip
            country
            phone
          }
          lineItems(first: 50) {
            edges {
              node {
                title
                sku
                quantity
                variant {
                  id
                  product {
                    id
                  }
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
                taxLines {
                  title
                  rate
                }
              }
            }
          }
          totalDiscountsSet {
            shopMoney {
              amount
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
            }
          }
          shippingLine {
            title
          }
          totalTaxSet {
            shopMoney {
              amount
            }
          }
          note
          discountCodes
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

export function normalizeOrderNode(node) {
  const address = node.customer?.defaultAddress || {};

  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    email: node.email || null,
    phone: node.phone || null,
    financialStatus: node.displayFinancialStatus || null,
    totalPrice: node.totalPriceSet?.shopMoney?.amount,
    paymentGatewayNames: node.paymentGatewayNames || [],
    customer: node.customer
      ? {
          id: node.customer.id,
          firstName: node.customer.firstName || "",
          lastName: node.customer.lastName || "",
          email: node.customer.email || node.email || "",
          phone: node.customer.phone || node.phone || "",
          address: {
            address1: address.address1 || "",
            address2: address.address2 || "",
            city: address.city || "",
            province: address.province || "",
            zip: address.zip || "",
            country: address.country || "",
            phone: address.phone || "",
          },
        }
      : null,
    billingAddress: {
      firstName: node.billingAddress?.firstName || "",
      lastName: node.billingAddress?.lastName || "",
      address1: node.billingAddress?.address1 || "",
      address2: node.billingAddress?.address2 || "",
      city: node.billingAddress?.city || "",
      province: node.billingAddress?.province || "",
      zip: node.billingAddress?.zip || "",
      country: node.billingAddress?.country || "",
      phone: node.billingAddress?.phone || "",
    },
    lineItems: (node.lineItems?.edges || []).map(({ node: lineItem }) => ({
      variantId: lineItem.variant?.id || null,
      productId: lineItem.variant?.product?.id || null,
      sku: lineItem.sku,
      title: lineItem.title,
      quantity: lineItem.quantity,
      price: lineItem.originalUnitPriceSet?.shopMoney?.amount,
      taxLines: (lineItem.taxLines || []).map((line) => ({
        title: line.title,
        rate: Number(line.rate) || 0,
      })),
    })),
    totalDiscount: node.totalDiscountsSet?.shopMoney?.amount,
    totalShipping: node.totalShippingPriceSet?.shopMoney?.amount,
    shippingMethod: node.shippingLine?.title || null,
    totalTax: node.totalTaxSet?.shopMoney?.amount,
    note: node.note || "",
    discountCodes: node.discountCodes || [],
  };
}

// Lightweight - only fetches what's needed to enumerate the distinct
// Shopify tax rate(s) actually in use, for the Settings page's tax-rate
// mapping table. Deliberately doesn't reuse the full ORDERS_QUERY (that
// pulls customer/address/price data this doesn't need).
const TAX_RATE_SAMPLE_QUERY = `#graphql
  query TaxRateSample($first: Int) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          lineItems(first: 50) {
            edges {
              node {
                taxLines {
                  title
                  rate
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Scans the most recent 250 orders (Shopify's max page size, one page - tax
// rates are a store-wide configuration that doesn't change per order, so a
// recent sample is enough to surface everything currently in use) and
// returns the distinct tax-rate combinations found, for the Settings page's
// mapping table.
export async function detectShopifyTaxRates(admin) {
  const response = await admin.graphql(TAX_RATE_SAMPLE_QUERY, {
    variables: { first: 250 },
  });
  const json = await response.json();
  const edges = json.data?.orders?.edges || [];

  const seen = new Map();
  for (const { node } of edges) {
    for (const { node: lineItem } of node.lineItems?.edges || []) {
      const key = buildTaxRateKey(lineItem.taxLines);
      if (key && !seen.has(key)) {
        seen.set(key, buildTaxRateLabel(lineItem.taxLines));
      }
    }
  }

  return Array.from(seen, ([key, label]) => ({ key, label }));
}

// The "Sync now"/"Sync everything" actions have to cover the whole order
// list regardless of how many orders a page happens to be displaying - so
// this pages through everything itself (250 at a time, the API max) rather
// than reusing the paginated display query. Exported for reuse by
// reportingSync.server.js's payment reconciliation, which needs each
// order's current Shopify total - nothing in this app's own DB stores that.
export async function fetchAllOrdersForSync(admin) {
  const allOrders = [];
  let after = null;

  for (;;) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: { first: 250, after },
    });
    const json = await response.json();
    const edges = json.data?.orders?.edges || [];

    allOrders.push(...edges.map(({ node }) => normalizeOrderNode(node)));

    const pageInfo = json.data?.orders?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return allOrders;
}

// Shared by `app.orders.jsx`'s own "Sync now" button and the Dashboard's
// "Sync everything" button (`app._index.jsx`) - covers order sync AND the
// invoice/payment backfill for already-paid orders, matching exactly what
// clicking "Sync now" on the Orders page has always done. Lives here (not
// in a route file) so it stays guaranteed server-only regardless of which
// route imports it.
//
// `syncInvoiceAndPaymentForOrder` is imported dynamically rather than at
// the top of this file - `paymentSync.server.js` already imports several
// things FROM this file (getOrderMappings, normalizeRestOrder,
// buildOrderCustomer), so a static top-level import back the other way
// would make the two modules circularly dependent at load time. Resolving
// it lazily, only once this function actually runs, sidesteps that
// entirely without needing to relocate either module's code.
export async function runOrderSync({ admin, shop, zohoAuth }) {
  const { syncInvoiceAndPaymentForOrder } = await import("./paymentSync.server");

  const logId = await startSyncLog(shop.id, {
    entityType: "order",
    direction: "shopify_to_zoho",
  });

  const appSettings = await getAppSettings(shop.id);
  const orders = await fetchAllOrdersForSync(admin);
  const [productMappings, customerMappings, orderMappings] = await Promise.all([
    getProductMappings(shop.id),
    getCustomerMappings(shop.id),
    getOrderMappings(shop.id),
  ]);

  const inventoryAccountId = appSettings.accountSettings?.inventoryAccountId;

  const results = [];
  for (const order of orders) {
    results.push(
      await syncOrderToZoho({
        shopId: shop.id,
        admin,
        zohoAuth,
        order,
        taxSettings: appSettings.taxSettings || {},
        productMappings,
        customerMappings,
        orderMappings,
        inventoryAccountId,
      }),
    );
  }

  const attempted = results.filter((result) => result.status !== "skipped");

  await finishSyncLog(logId, {
    recordsProcessed: attempted.length,
    recordsSuccess: attempted.filter((result) => result.status === "success").length,
    recordsFailed: attempted.filter((result) => result.status === "error").length,
    metadata: attempted,
  });

  // Backfill invoices + payments for already-paid orders that don't have
  // them yet - covers orders paid before Zoho was connected, or before the
  // orders/paid webhook existed, since Shopify never replays past webhook
  // events for a new subscription. Re-fetch order mappings fresh (rather
  // than reusing the snapshot above) since the sales-order loop just above
  // may have just created brand new ones - reusing the stale snapshot
  // would make syncInvoiceForOrder think those orders still need a sales
  // order and create a duplicate one.
  const invoiceLogId = await startSyncLog(shop.id, {
    entityType: "invoice",
    direction: "shopify_to_zoho",
  });
  const paymentLogId = await startSyncLog(shop.id, {
    entityType: "payment",
    direction: "shopify_to_zoho",
  });

  const freshOrderMappings = await getOrderMappings(shop.id);
  const paidOrders = orders.filter((order) => order.financialStatus === "PAID");

  const invoiceResults = [];
  const paymentResults = [];
  for (const order of paidOrders) {
    const { invoice, payment } = await syncInvoiceAndPaymentForOrder({
      shopId: shop.id,
      zohoAuth,
      order,
      taxSettings: appSettings.taxSettings || {},
      accountSettings: appSettings.accountSettings || {},
      productMappings,
      customerMappings,
      orderMappings: freshOrderMappings,
    });
    invoiceResults.push(invoice);
    if (payment) paymentResults.push(payment);
  }

  const invoiceAttempted = invoiceResults.filter((result) => result.status !== "skipped");
  const paymentAttempted = paymentResults.filter((result) => result.status !== "skipped");

  await finishSyncLog(invoiceLogId, {
    recordsProcessed: invoiceAttempted.length,
    recordsSuccess: invoiceAttempted.filter((result) => result.status === "success").length,
    recordsFailed: invoiceAttempted.filter((result) => result.status === "error").length,
    metadata: invoiceAttempted,
  });
  await finishSyncLog(paymentLogId, {
    recordsProcessed: paymentAttempted.length,
    recordsSuccess: paymentAttempted.filter((result) => result.status === "success").length,
    recordsFailed: paymentAttempted.filter((result) => result.status === "error").length,
    metadata: paymentAttempted,
  });

  return {
    processed: attempted.length,
    success: attempted.filter((result) => result.status === "success").length,
    failed: attempted.filter((result) => result.status === "error").length,
  };
}

// Shopify's orders/create and orders/updated webhooks deliver the classic
// REST-shaped order resource - normalize it to the same shape the
// GraphQL-based bulk sync uses. Variant/product GIDs aren't present on REST
// line items (only their numeric ids), but Shopify's GID format is
// deterministic, so they're rebuilt the same way products/delete's webhook
// rebuilds a product GID from a bare numeric id.
export function normalizeRestOrder(payload) {
  const billing = payload.billing_address || {};

  return {
    id: payload.admin_graphql_api_id,
    name: payload.name,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at || payload.created_at,
    email: payload.email || payload.contact_email || null,
    phone: payload.phone || null,
    totalPrice: payload.total_price,
    paymentGatewayNames: payload.payment_gateway_names || [],
    customer: payload.customer
      ? {
          id: payload.customer.admin_graphql_api_id,
          firstName: payload.customer.first_name || "",
          lastName: payload.customer.last_name || "",
          email: payload.customer.email || payload.email || "",
          phone: payload.customer.phone || payload.phone || "",
          address: {
            address1: billing.address1 || "",
            address2: billing.address2 || "",
            city: billing.city || "",
            province: billing.province || "",
            zip: billing.zip || "",
            country: billing.country || "",
            phone: billing.phone || "",
          },
        }
      : null,
    billingAddress: {
      firstName: billing.first_name || "",
      lastName: billing.last_name || "",
      address1: billing.address1 || "",
      address2: billing.address2 || "",
      city: billing.city || "",
      province: billing.province || "",
      zip: billing.zip || "",
      country: billing.country || "",
      phone: billing.phone || "",
    },
    lineItems: (payload.line_items || []).map((lineItem) => ({
      variantId: lineItem.variant_id
        ? `gid://shopify/ProductVariant/${lineItem.variant_id}`
        : null,
      productId: lineItem.product_id
        ? `gid://shopify/Product/${lineItem.product_id}`
        : null,
      sku: lineItem.sku,
      title: lineItem.title,
      quantity: lineItem.quantity,
      price: lineItem.price,
      taxLines: (lineItem.tax_lines || []).map((line) => ({
        title: line.title,
        rate: Number(line.rate) || 0,
      })),
    })),
    totalDiscount: payload.total_discounts,
    totalShipping:
      payload.total_shipping_price_set?.shop_money?.amount ||
      (payload.shipping_lines || []).reduce(
        (sum, line) => sum + Number(line.price || 0),
        0,
      ),
    shippingMethod: payload.shipping_lines?.[0]?.title || null,
    totalTax: payload.total_tax,
    note: payload.note || "",
    discountCodes: (payload.discount_codes || []).map((entry) => entry.code),
  };
}

// Shared body for the orders/create and orders/updated webhook routes -
// always resolves (never throws) so the route can respond 200 to Shopify
// regardless of what happened internally; failures are recorded in
// webhook_logs instead of surfacing as a delivery failure.
export async function processOrderUpsertWebhook({
  shop: shopDomain,
  topic,
  webhookId,
  payload,
}) {
  const { shop, connection } = await getConnectionForShopDomain(shopDomain);

  const logId = await recordWebhookReceived(shop.id, {
    webhookId,
    topic,
    shopDomain,
    resourceId: payload.admin_graphql_api_id,
    payload,
  });

  if (!logId) return; // Duplicate delivery of a webhook we've already processed.

  if (!connection) {
    await finishWebhookLog(logId, {
      status: "skipped",
      errorMessage: "Zoho Books is not connected for this shop",
    });
    return;
  }

  try {
    const token = await getValidAccessToken(shop.id);
    if (!token) throw new Error("No valid Zoho access token");

    const zohoAuth = {
      accessToken: token.accessToken,
      apiDomain: token.apiDomain,
      organizationId: connection.organization_id,
    };
    const order = normalizeRestOrder(payload);
    const appSettings = await getAppSettings(shop.id);
    const [productMappings, customerMappings, orderMappings] = await Promise.all([
      getProductMappings(shop.id),
      getCustomerMappings(shop.id),
      getOrderMappings(shop.id),
    ]);

    const result = await syncOrderToZoho({
      shopId: shop.id,
      zohoAuth,
      order,
      taxSettings: appSettings.taxSettings || {},
      productMappings,
      customerMappings,
      orderMappings,
      inventoryAccountId: appSettings.accountSettings?.inventoryAccountId,
    });

    await finishWebhookLog(logId, {
      status: result.status === "error" ? "failed" : "processed",
      errorMessage: result.status === "error" ? result.error : null,
    });
  } catch (error) {
    console.error("Failed to process order webhook", topic, error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }
}

// Cancelling a Shopify order doesn't delete it, so the matching Zoho sales
// order is voided (not deleted) - this keeps the record for accounting
// purposes while marking it inactive. The mapping row is kept (status
// "voided") rather than removed, unlike product/customer deletion, since
// the Shopify order itself still exists.
export async function syncOrderCancellationToZoho({ shopId, zohoAuth, shopifyOrderId }) {
  const mapping = await getOrderMapping(shopId, shopifyOrderId);
  if (!mapping) return { status: "skipped" };

  try {
    await voidZohoSalesOrder(zohoAuth, mapping.zoho_id);
    await markOrderMappingVoided(shopId, shopifyOrderId);
    return { zohoSalesOrderId: mapping.zoho_id, status: "voided" };
  } catch (error) {
    console.error("Failed to void Zoho sales order for cancelled order", mapping.zoho_id, error);
    const description = describeZohoError(error);
    await markOrderMappingError(shopId, shopifyOrderId, description);
    return { zohoSalesOrderId: mapping.zoho_id, status: "error", error: description };
  }
}
