import db from "../db.server";
import { fetchZohoInvoice } from "../zoho.server";
import { fetchAllOrdersForSync } from "./orderSync.server";
import { getInvoiceMappings } from "./invoiceSync.server";
import { getPaymentMappings } from "./paymentSync.server";
import { startSyncLog, finishSyncLog } from "./syncLog.server";

function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

export async function getSyncActivitySummary(shopId, { days = 30 } = {}) {
  const [rows] = await db.execute(
    `SELECT entity_type, COUNT(*) AS runs, SUM(records_processed) AS processed, SUM(records_success) AS success, SUM(records_failed) AS failed, MAX(COALESCE(completed_at, started_at)) AS last_run_at FROM sync_logs WHERE shop_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY entity_type`,
    [shopId, days],
  );
  return Object.fromEntries(rows.map((row) => [row.entity_type, row]));
}

export async function getRecentSyncRuns(shopId, limit = 20) {
  const safeLimit = Number.isInteger(limit) ? limit : 20;
  const [rows] = await db.execute(`SELECT * FROM sync_logs WHERE shop_id = ? ORDER BY id DESC LIMIT ${safeLimit}`, [shopId]);
  return rows;
}

export async function getSyncHistoryStats(shopId) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS in_progress, SUM(CASE WHEN status = 'completed_with_errors' OR status = 'failed' THEN 1 ELSE 0 END) AS failed, MAX(COALESCE(completed_at, started_at)) AS last_sync_at FROM sync_logs WHERE shop_id = ?`,
    [shopId],
  );
  return rows[0] || { total: 0, successful: 0, in_progress: 0, failed: 0, last_sync_at: null };
}

function buildSyncHistoryFilters(shopId, { search = "", entity = "all", status = "all", from = "", to = "" } = {}) {
  const conditions = ["shop_id = ?"];
  const params = [shopId];
  if (search.trim()) {
    conditions.push("(CAST(id AS CHAR) LIKE ? OR entity_type LIKE ? OR direction LIKE ? OR status LIKE ?)");
    const q = `%${search.trim()}%`;
    params.push(q, q, q, q);
  }
  if (entity !== "all") {
    conditions.push("entity_type = ?");
    params.push(entity);
  }
  if (status !== "all") {
    const statuses = { success: "completed", in_progress: "running", failed: "completed_with_errors" };
    conditions.push("status = ?");
    params.push(statuses[status] || status);
  }
  if (from) {
    conditions.push("started_at >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    conditions.push("started_at <= ?");
    params.push(`${to} 23:59:59`);
  }
  return { where: conditions.join(" AND "), params };
}

export async function getSyncHistoryPage(shopId, options = {}) {
  const { page = 1, pageSize = 8, search = "", entity = "all", status = "all", from = "", to = "" } = options;
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(50, Math.max(1, Number(pageSize) || 8));
  const offset = (safePage - 1) * safePageSize;
  const { where, params } = buildSyncHistoryFilters(shopId, { search, entity, status, from, to });
  const [countRows] = await db.execute(`SELECT COUNT(*) AS total FROM sync_logs WHERE ${where}`, params);
  const total = Number(countRows[0]?.total || 0);
  const [rows] = await db.execute(`SELECT * FROM sync_logs WHERE ${where} ORDER BY id DESC LIMIT ${safePageSize} OFFSET ${offset}`, params);
  return { rows, total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
}

export async function getSyncHistoryAll(shopId, options = {}) {
  const { search = "", entity = "all", status = "all", from = "", to = "" } = options;
  const { where, params } = buildSyncHistoryFilters(shopId, { search, entity, status, from, to });
  const [rows] = await db.execute(`SELECT * FROM sync_logs WHERE ${where} ORDER BY id DESC`, params);
  return { rows, total: rows.length };
}

const RECONCILE_EPSILON = 0.01;

export async function reconcilePayments({ shopId, admin, zohoAuth }) {
  const logId = await startSyncLog(shopId, { entityType: "reconciliation", direction: "zoho_to_shopify" });
  const [invoiceMappings, paymentMappings, orders] = await Promise.all([getInvoiceMappings(shopId), getPaymentMappings(shopId), fetchAllOrdersForSync(admin)]);
  const results = [];
  for (const order of orders) {
    const payment = paymentMappings[order.id];
    if (!payment || payment.status !== "synced") continue;
    const invoice = invoiceMappings[order.id];
    if (!invoice?.zohoId) continue;
    try {
      const zohoInvoice = await fetchZohoInvoice(zohoAuth, invoice.zohoId);
      const shopifyTotal = Number(order.totalPrice) || 0;
      const zohoTotal = Number(zohoInvoice.total) || 0;
      results.push({ orderName: order.name, shopifyTotal, zohoTotal, zohoBalance: Number(zohoInvoice.balance) || 0, status: Math.abs(shopifyTotal - zohoTotal) > RECONCILE_EPSILON ? "mismatch" : "match" });
    } catch (error) {
      results.push({ orderName: order.name, status: "error", error: describeZohoError(error) });
    }
  }
  await finishSyncLog(logId, { recordsProcessed: results.length, recordsSuccess: results.filter((result) => result.status === "match").length, recordsFailed: results.filter((result) => result.status !== "match").length, metadata: results });
  return results;
}
