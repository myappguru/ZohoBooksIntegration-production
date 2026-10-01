import { boundary } from "@shopify/shopify-app-react-router/server";
import { Form, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { useRevalidateWhileRunning } from "../hooks/useRevalidateWhileRunning";
import { getConnectionForShopDomain, getValidAccessToken } from "../models/zohoConnection.server";
import { getSyncedProductCount, runProductSync } from "../models/productSync.server";
import { getSyncedCustomerCount, runCustomerSync } from "../models/customerSync.server";
import { getSyncedOrderCount, runOrderSync } from "../models/orderSync.server";
import { getSyncedWebhookCount } from "../models/webhookLog.server";
import { runInventoryPull } from "../models/inventorySync.server";
import { getLatestSyncLog } from "../models/syncLog.server";
import { startSyncJob } from "../models/syncJobs.server";
import OtherApps from "../components/Common/OtherApps";
import { useZohoConnectionSync } from "../hooks/useZohoConnectionSync";

const syncStats = [
  { key: "products", label: "Products", iconType: "product", tone: "info" },
  { key: "customers", label: "Customers", iconType: "person", tone: "neutral" },
  { key: "orders", label: "Orders", iconType: "order", tone: "caution" },
  { key: "inventory", label: "Inventory Items", iconType: "inventory", tone: "success" },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  const [productCount, customerCount, orderCount, inventoryCount, productLog, customerLog, orderLog, inventoryLog] = connection
    ? await Promise.all([
      getSyncedProductCount(shop.id),
      getSyncedCustomerCount(shop.id),
      getSyncedOrderCount(shop.id),
      getSyncedWebhookCount(shop.id, "INVENTORY_LEVELS_UPDATE"),
      getLatestSyncLog(shop.id, "product"),
      getLatestSyncLog(shop.id, "customer"),
      getLatestSyncLog(shop.id, "order"),
      getLatestSyncLog(shop.id, "inventory"),
    ])
    : [0, 0, 0, 0, null, null, null, null];

  return {
    shopDomain: session.shop,
    zohoConnected: Boolean(connection),
    zohoNeedsReauth: Boolean(connection?.needs_reauth),
    zohoOrganizationName: connection?.organization_name || null,
    syncCounts: { products: productCount, customers: customerCount, orders: orderCount, inventory: inventoryCount },
    recentLogs: { products: productLog, customers: customerLog, orders: orderLog, inventory: inventoryLog },
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") !== "sync-all") return null;
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  if (!connection) return null;
  const token = await getValidAccessToken(shop.id).catch((error) => {
    console.error("Failed to get a valid Zoho access token for sync-all", error);
    return null;
  });
  if (!token) return null;
  const zohoAuth = { accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id };
  // Runs in the background - a full sync can take far longer than a request.
  const job = startSyncJob(shop.id, "sync-all", async () => {
    await runProductSync({ admin, shop, zohoAuth });
    await runCustomerSync({ admin, shop, zohoAuth });
    await runOrderSync({ admin, shop, zohoAuth });
    await runInventoryPull({ admin, shop, zohoAuth });
  });
  return { ok: true, started: job.started, message: job.started ? "Sync started. Results appear here as each step finishes." : "A sync is already running." };
};

function formatCount(value) { return new Intl.NumberFormat().format(value || 0); }
function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function getSuccessRate(log) {
  if (!log?.records_processed) return null;
  return Math.round(((log.records_success || 0) / log.records_processed) * 100);
}
function getRelativeTime(value) {
  if (!value) return "No sync yet";
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
function formatDuration(log) {
  if (!log?.started_at || !log?.completed_at) return "—";
  const seconds = Math.max(0, Math.round((new Date(log.completed_at) - new Date(log.started_at)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function Index() {
  const { zohoConnected, zohoNeedsReauth, zohoOrganizationName, syncCounts, recentLogs } = useLoaderData();
  useRevalidateWhileRunning(Object.values(recentLogs || {}));
  const { connectZoho } = useZohoConnectionSync();
  const navigation = useNavigation();
  const isRefreshing = navigation.state === "loading";
  const isSyncingAll = navigation.state === "submitting" && navigation.formData?.get("intent") === "sync-all";
  const logs = syncStats.map((stat) => ({ ...stat, log: recentLogs[stat.key], count: syncCounts[stat.key] || 0 }));
  const lastSync = logs.filter((item) => item.log).sort((a, b) => new Date(b.log.completed_at || b.log.started_at) - new Date(a.log.completed_at || a.log.started_at))[0]?.log;
  const hasActivity = logs.some((item) => item.log);

  return (
    <s-page heading="Dashboard" inlineSize="large">
      <style>{`
        .dashboard { width:80%; max-width:none; margin:0 auto; display:flex; flex-direction:column; gap:12px; padding:0 0 20px; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#202223; }
        .dashboard-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:2px 0; }
        .dashboard-title { font-size:20px; line-height:26px; font-weight:650; margin:0; letter-spacing:-.01em; color:#202223; }
        .dashboard-subtitle { margin:2px 0 0; color:#616161; font-size:15px; line-height:21px; }
        .dashboard-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .kpi-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
        .kpi-card,.panel,.connection-card { background:#fff; border:1px solid #dfe3e8; border-radius:10px; box-shadow:0 1px 1px rgba(0,0,0,.03); }
        .kpi-card { padding:14px 16px 13px; min-height:108px; display:flex; flex-direction:column; justify-content:space-between; box-sizing:border-box; }
        .kpi-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .kpi-label { font-size:12px; line-height:16px; font-weight:600; color:#303030; }
        .kpi-icon { width:38px; height:38px; border-radius:9px; display:grid; place-items:center; flex:0 0 38px; background:#eef6ff; }
        .kpi-icon s-icon { width:20px; height:20px; }
        .kpi-card:nth-child(2) .kpi-icon { background:#f4ecff; }
        .kpi-card:nth-child(3) .kpi-icon { background:#fff5e5; }
        .kpi-card:nth-child(4) .kpi-icon { background:#e8f8f6; }
        .kpi-number { font-size:26px; line-height:30px; font-weight:650; margin-top:4px; color:#202223; letter-spacing:-.02em; }
        .kpi-meta { display:flex; align-items:center; gap:7px; color:#6d7175; font-size:11px; line-height:16px; }
        .success-text { color:#008060; font-weight:600; }
        .connection-card { min-height:66px; padding:10px 16px; display:grid; grid-template-columns:1fr 300px 1fr; align-items:center; gap:16px; box-sizing:border-box; }
        .connection-side { display:flex; align-items:center; gap:10px; min-width:0; }
        .connection-side.right { justify-content:flex-end; }
        .connection-logo { width:38px; height:38px; border-radius:9px; display:grid; place-items:center; background:#eaf7e9; border:1px solid #d7ecd5; flex:0 0 38px; }
        .connection-logo.zoho { background:#edf4ff; border-color:#dbe8ff; }
        .connection-logo s-icon { width:20px; height:20px; }
        .connection-name { font-weight:650; font-size:13px; line-height:17px; }
        .connection-caption { color:#6d7175; font-size:13px; line-height:18px; margin-top:1px; }
        .connection-center { display:flex; align-items:center; justify-content:center; gap:10px; min-width:0; }
        .connection-line { height:1px; border-top:1px dashed #aeb4ba; flex:1; min-width:50px; }
        .connected-pill { display:inline-flex; align-items:center; gap:5px; background:#e3f7ed; color:#008060; border-radius:999px; padding:5px 10px; font-size:11px; line-height:14px; font-weight:650; white-space:nowrap; }
        .connected-dot { width:6px; height:6px; border-radius:50%; background:#00a47c; }
        .connection-right { text-align:right; }
        .connection-right strong { display:block; font-size:13px; line-height:17px; font-weight:650; }
        .connection-right span { color:#6d7175; font-size:13px; line-height:18px; }
        .two-column { display:grid; grid-template-columns:1.05fr .95fr; gap:12px; }
        .panel { overflow:hidden; min-width:0; }
        .panel-header { padding:12px 16px 8px; }
        .panel-title { margin:0; font-size:14px; line-height:19px; font-weight:650; color:#202223; }
        .panel-subtitle { margin:1px 0 0; color:#6d7175; font-size:13px; line-height:18px; }
        .sync-row { display:grid; grid-template-columns:145px minmax(90px,1fr) 38px 68px; align-items:center; gap:10px; padding:8px 16px; }
        .sync-label { display:flex; align-items:center; gap:7px; font-size:12px; line-height:16px; font-weight:600; }
        .sync-label s-icon { width:15px; height:15px; }
        .sync-dot { width:6px; height:6px; border-radius:50%; background:#00a47c; flex:0 0 6px; }
        .progress-track { height:5px; background:#e9edf1; border-radius:999px; overflow:hidden; }
        .progress-fill { height:100%; background:#4263eb; border-radius:999px; }
        .progress-value { font-size:11px; line-height:15px; font-weight:650; text-align:right; }
        .progress-count { font-size:10px; line-height:15px; color:#6d7175; text-align:right; }
        .activity-list { display:flex; flex-direction:column; }
        .activity-row { display:grid; grid-template-columns:22px minmax(0,1fr) auto auto; gap:8px; align-items:center; padding:8px 16px; border-top:1px solid #edf0f2; }
        .activity-icon { width:20px; height:20px; border-radius:50%; display:grid; place-items:center; background:#e3f7ed; color:#008060; font-size:11px; line-height:20px; font-weight:700; }
        .activity-title { font-size:11px; line-height:15px; font-weight:650; color:#202223; }
        .activity-meta { font-size:9px; line-height:14px; color:#6d7175; margin-top:1px; }
        .status-pill { padding:3px 8px; border-radius:999px; background:#e3f7ed; color:#008060; font-size:9px; line-height:13px; font-weight:650; white-space:nowrap; }
        .status-partial { background:#fff1e6; color:#b98900; }
        .activity-time { font-size:9px; line-height:14px; color:#6d7175; white-space:nowrap; }
        .history-table { width:100%; border-collapse:collapse; table-layout:fixed; }
        .history-table th { text-align:left; padding:8px 16px; background:#f6f7f8; color:#6d7175; font-size:9px; line-height:14px; font-weight:650; text-transform:uppercase; letter-spacing:.035em; }
        .history-table td { padding:8px 16px; border-top:1px solid #edf0f2; font-size:13px; line-height:15px; color:#303030; vertical-align:middle; }
        .history-type { display:flex; align-items:center; gap:7px; font-weight:600; color:#202223; }
        .history-type s-icon { width:15px; height:15px; }
        .details-link { color:#0066ff; font-size:13px; line-height:18px; text-decoration:none; font-weight:550; }
        .history-footer { padding:9px 16px; border-top:1px solid #edf0f2; text-align:center; }
        .history-footer a { color:#0066ff; font-size:13px; line-height:18px; font-weight:600; text-decoration:none; }
        .empty-state { padding:22px 16px; color:#6d7175; font-size:13px; line-height:18px; text-align:center; }
        .last-sync { color:#6d7175; font-size:13px; line-height:18px; }
        @media (max-width:900px) { .dashboard { width:100%; } .kpi-grid,.two-column { grid-template-columns:1fr 1fr; } .connection-card { grid-template-columns:1fr; } .connection-center { order:2; } .connection-side.right { justify-content:flex-start; } .connection-right { text-align:left; } }
        @media (max-width:620px) { .kpi-grid,.two-column { grid-template-columns:1fr; } .dashboard-header { flex-direction:column; } .sync-row { grid-template-columns:110px 1fr 38px; } .progress-count { display:none; } .activity-row { grid-template-columns:22px 1fr auto; } .activity-time { display:none; } .history-table { min-width:620px; } .panel { overflow-x:auto; } }
      `}</style>

      <div className="dashboard">
        <div className="dashboard-header">
          <div><h1 className="dashboard-title">Dashboard</h1><p className="dashboard-subtitle">Overview of your Shopify &amp; Zoho Books synchronization</p></div>
          <div className="dashboard-actions">
            <Form method="get">
              <s-button icon="refresh" type="submit" loading={isRefreshing} disabled={isRefreshing || isSyncingAll}>Refresh</s-button>
            </Form>
            <Form method="post"><input type="hidden" name="intent" value="sync-all" /><s-button variant="primary" icon="refresh" type="submit" loading={isSyncingAll} disabled={!zohoConnected || isRefreshing}>Sync Now</s-button></Form>
          </div>
        </div>

        <div className="kpi-grid">
          {logs.map((item) => <div className="kpi-card" key={item.key}><div className="kpi-top"><span className="kpi-label">{item.label}</span><span className="kpi-icon"><s-icon type={item.iconType} tone={item.tone}></s-icon></span></div><div className="kpi-number">{formatCount(item.count)}</div><div className="kpi-meta">{item.log ? <span className="success-text">Synced</span> : <span>Not synced yet</span>}<span>•</span><span>{getRelativeTime(item.log?.completed_at || item.log?.started_at)}</span></div></div>)}
        </div>

        <div className="connection-card">
          <div className="connection-side"><div className="connection-logo"><s-icon type="store" tone="success"></s-icon></div><div><div className="connection-name">Shopify</div><div className="connection-caption">Store connected and ready to sync</div></div></div>
          <div className="connection-center"><span className="connection-line"></span><span className="connected-pill"><span className="connected-dot"></span>{zohoNeedsReauth ? "Reconnect Zoho" : zohoConnected ? "Connected" : "Zoho not connected"}</span><span className="connection-line"></span></div>
          <div className="connection-side right"><div className="connection-right"><strong>{zohoConnected ? "Zoho Books" : "Connect Zoho Books"}</strong><span>{zohoNeedsReauth ? "Zoho access expired or was revoked - reconnect to resume syncing" : zohoConnected ? (zohoOrganizationName || "Organization connected") : "Authorize your Zoho organization to enable sync"}</span>{(!zohoConnected || zohoNeedsReauth) && <div style={{ marginTop: 6 }}><s-button variant="primary" onClick={connectZoho}>{zohoNeedsReauth ? "Reconnect" : "Connect"}</s-button></div>}</div><div className="connection-logo zoho"><s-icon type="link" tone={zohoConnected ? "info" : "caution"}></s-icon></div></div>
        </div>

        <div className="two-column">
          <div className="panel"><div className="panel-header"><h2 className="panel-title">Sync Overview</h2><p className="panel-subtitle">Latest synchronization success by data type</p></div>
            {logs.map((item) => { const rate = getSuccessRate(item.log) ?? (item.count > 0 ? 100 : 0); return <div className="sync-row" key={item.key}><div className="sync-label"><span className="sync-dot"></span><s-icon type={item.iconType} tone={item.tone}></s-icon>{item.label.replace(" Items", "")}</div><div className="progress-track"><div className="progress-fill" style={{ width: `${rate}%` }}></div></div><div className="progress-value">{rate}%</div><div className="progress-count">{formatCount(item.count)} synced</div></div>; })}
            <div className="history-footer"><a href="/app/sync-history">View detailed sync history →</a></div>
          </div>

          <div className="panel"><div className="panel-header"><h2 className="panel-title">Recent Activity</h2><p className="panel-subtitle">Latest synchronization activities</p></div>
            <div className="activity-list">{hasActivity ? logs.filter((item) => item.log).map((item) => { const failed = Number(item.log.records_failed || 0) > 0; return <div className="activity-row" key={item.key}><span className="activity-icon">✓</span><div><div className="activity-title">{item.label.replace(" Items", "")} sync {failed ? "partially completed" : "completed"}</div><div className="activity-meta">{formatCount(item.log.records_processed)} records processed · {formatCount(item.log.records_success)} succeeded</div></div><span className={`status-pill ${failed ? "status-partial" : ""}`}>{failed ? "Partial" : "Success"}</span><span className="activity-time">{formatDate(item.log.completed_at || item.log.started_at)}</span></div>; }) : <div className="empty-state">No synchronization activity yet.</div>}</div>
            <div className="history-footer"><a href="/app/sync-history">View all activities →</a></div>
          </div>
        </div>

        <div className="panel"><div className="panel-header"><h2 className="panel-title">Recent Sync History</h2><p className="panel-subtitle">Summary of recent synchronization operations</p></div>
          {hasActivity ? <table className="history-table"><thead><tr><th>Type</th><th>Records</th><th>Status</th><th>Date &amp; Time</th><th>Duration</th><th>Details</th></tr></thead><tbody>{logs.filter((item) => item.log).map((item) => { const failed = Number(item.log.records_failed || 0) > 0; return <tr key={item.key}><td><span className="history-type"><s-icon type={item.iconType} tone={item.tone}></s-icon>{item.label.replace(" Items", "")}</span></td><td>{formatCount(item.log.records_processed)}</td><td><span className={`status-pill ${failed ? "status-partial" : ""}`}>{failed ? "Partial" : "Success"}</span></td><td>{formatDate(item.log.completed_at || item.log.started_at)}</td><td>{formatDuration(item.log)}</td><td><a className="details-link" href="/app/sync-history">View details</a></td></tr>; })}</tbody></table> : <div className="empty-state">Your recent sync operations will appear here.</div>}
          <div className="history-footer"><a href="/app/sync-history">View full sync history →</a></div>
        </div>

        <OtherApps />
        {lastSync && <div className="last-sync">Last synchronization: {formatDate(lastSync.completed_at || lastSync.started_at)}</div>}
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
