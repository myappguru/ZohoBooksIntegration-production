import { useMemo, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { getCustomerMappings, normalizeCustomerNode, runCustomerSync, syncCustomerToZoho } from "../models/customerSync.server";
import { getConnectionForShopDomain, getValidAccessToken } from "../models/zohoConnection.server";
import { getLatestSyncLog } from "../models/syncLog.server";

const PAGE_SIZE = 20;

const CUSTOMER_PAGE_QUERY = `#graphql
  query CustomersPage($first: Int, $after: String, $last: Int, $before: String) {
    customers(first: $first, after: $after, last: $last, before: $before) {
      edges {
        node {
          id firstName lastName email phone state tags numberOfOrders
          amountSpent { amount currencyCode }
          defaultAddress { address1 address2 city province zip country phone }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const CUSTOMER_BY_ID_QUERY = `#graphql
  query CustomerById($id: ID!) {
    customer(id: $id) {
      id firstName lastName email phone
      defaultAddress { address1 address2 city province zip country phone }
    }
  }
`;

function shopifyNumericId(gid) { return gid ? gid.split("/").pop() : null; }
function normalizeCustomerPageNode(node) {
  return {
    ...normalizeCustomerNode(node),
    state: node.state || "ENABLED",
    tags: node.tags || [],
    numberOfOrders: Number(node.numberOfOrders || 0),
    amountSpent: node.amountSpent?.amount || "0.00",
    amountSpentCurrency: node.amountSpent?.currencyCode || "USD",
  };
}
async function fetchCustomersPage(admin, { after, before } = {}) {
  const variables = before ? { last: PAGE_SIZE, before } : { first: PAGE_SIZE, after: after || null };
  const response = await admin.graphql(CUSTOMER_PAGE_QUERY, { variables });
  const json = await response.json();
  return {
    customers: (json.data?.customers?.edges || []).map(({ node }) => normalizeCustomerPageNode(node)),
    pageInfo: json.data?.customers?.pageInfo || { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  const url = new URL(request.url);
  const after = url.searchParams.get("after") || undefined;
  const before = url.searchParams.get("before") || undefined;
  const { customers, pageInfo } = await fetchCustomersPage(admin, { after, before });
  const mappings = connection ? await getCustomerMappings(shop.id) : {};
  const latestLog = connection ? await getLatestSyncLog(shop.id, "customer") : null;
  return { connected: Boolean(connection), customers, pageInfo, mappings, latestLog };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  if (!connection) return { ok: false, message: "Connect Zoho Books before syncing customers." };
  const token = await getValidAccessToken(shop.id).catch((error) => {
    console.error("Failed to get a valid Zoho access token for customer sync", error);
    return null;
  });
  if (!token) return { ok: false, message: "Unable to get a valid Zoho access token." };
  const zohoAuth = { accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id };

  if (intent === "sync-now") {
    const result = await runCustomerSync({ admin, shop, zohoAuth });
    return { ok: true, type: "bulk", result, message: `${result.success} customers synced successfully${result.failed ? `, ${result.failed} failed` : ""}.` };
  }
  if (intent === "sync-customer") {
    const customerId = formData.get("customerId");
    if (!customerId) return { ok: false, message: "Customer ID is missing." };
    const response = await admin.graphql(CUSTOMER_BY_ID_QUERY, { variables: { id: customerId } });
    const json = await response.json();
    const node = json.data?.customer;
    if (!node) return { ok: false, message: "Customer could not be found in Shopify." };
    const mappings = await getCustomerMappings(shop.id);
    const result = await syncCustomerToZoho({ shopId: shop.id, zohoAuth, customer: normalizeCustomerNode(node), mappings });
    return { ok: result.status === "success", type: "single", customerId, result, message: result.status === "success" ? "Customer synced successfully." : result.error || "Customer sync failed." };
  }
  return null;
};

function formatCount(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function formatDate(value) { if (!value) return "—"; return new Date(value).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function formatCurrency(value, currency) { const amount = Number(value || 0); try { return new Intl.NumberFormat([], { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(amount); } catch { return `${currency || "USD"} ${amount.toFixed(2)}`; } }
function fullName(customer) { return `${customer.firstName} ${customer.lastName}`.trim() || "(No name)"; }
function initials(customer) { const parts = fullName(customer).replace(/[()]/g, "").split(/\s+/).filter(Boolean); return (parts[0]?.[0] || "?") + (parts[1]?.[0] || ""); }

export default function CustomersPage() {
  const { connected, customers, pageInfo, mappings, latestLog } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [search, setSearch] = useState("");
  const [syncFilter, setSyncFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [emailFilter, setEmailFilter] = useState("all");
  const [phoneFilter, setPhoneFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [openMenu, setOpenMenu] = useState(null);
  const isBulkSyncing = navigation.state === "submitting" && navigation.formData?.get("intent") === "sync-now";
  const syncingCustomerId = navigation.state === "submitting" && navigation.formData?.get("intent") === "sync-customer" ? navigation.formData?.get("customerId") : null;
  const isRefreshing = navigation.state === "loading";
  const showLog = useAutoDismiss(latestLog?.id);

  const filteredCustomers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return customers.filter((customer) => {
      const mapping = mappings[customer.id];
      const syncStatus = !mapping ? "not-synced" : mapping.status === "error" ? "error" : "synced";
      const haystack = [fullName(customer), customer.email, customer.phone, ...(customer.tags || [])].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (syncFilter !== "all" && syncStatus !== syncFilter) return false;
      if (statusFilter !== "all" && customer.state !== statusFilter) return false;
      if (emailFilter === "with" && !customer.email) return false;
      if (emailFilter === "without" && customer.email) return false;
      if (phoneFilter === "with" && !customer.phone) return false;
      if (phoneFilter === "without" && customer.phone) return false;
      if (tagFilter === "with" && !(customer.tags || []).length) return false;
      if (tagFilter === "without" && (customer.tags || []).length) return false;
      return true;
    });
  }, [customers, mappings, search, syncFilter, statusFilter, emailFilter, phoneFilter, tagFilter]);

  const syncedCount = customers.filter((customer) => mappings[customer.id]?.status === "synced").length;
  const errorCount = customers.filter((customer) => mappings[customer.id]?.status === "error").length;
  const pendingCount = Math.max(0, customers.length - syncedCount - errorCount);
  const activeMoreFilters = [emailFilter !== "all", phoneFilter !== "all", tagFilter !== "all"].filter(Boolean).length;
  const hasActiveFilters = Boolean(search) || syncFilter !== "all" || statusFilter !== "all" || activeMoreFilters > 0;
  const clearFilters = () => { setSearch(""); setSyncFilter("all"); setStatusFilter("all"); setEmailFilter("all"); setPhoneFilter("all"); setTagFilter("all"); };

  return (
    <s-page heading="Customers" inlineSize="large">
      <style>{`
        .customers-page{width:80%;max-width:1260px;margin:0 auto;padding:8px 0 24px;color:#202223;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
        .customers-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.customers-title{margin:0;font-size:20px;line-height:26px;font-weight:650;letter-spacing:-.01em}.customers-subtitle{margin:2px 0 0;color:#616161;font-size:15px;line-height:21px}.customers-actions{display:flex;gap:8px;flex-shrink:0}
        .stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}.stat-card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;min-height:112px;padding:14px 16px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 1px 1px rgba(0,0,0,.03)}.stat-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.stat-label{font-size:12px;line-height:16px;font-weight:600;color:#303030}.stat-icon{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:#eef6ff}.stat-card:nth-child(2) .stat-icon{background:#e7f7ef}.stat-card:nth-child(3) .stat-icon{background:#fff5e5}.stat-card:nth-child(4) .stat-icon{background:#f4eaff}.stat-number{font-size:26px;line-height:30px;font-weight:650;margin-top:4px;letter-spacing:-.02em}.stat-caption{font-size:13px;line-height:18px;color:#6d7175}
        .toolbar{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:12px;display:flex;align-items:center;gap:8px;margin-bottom:12px;box-shadow:0 1px 1px rgba(0,0,0,.03);position:relative}.search-box{height:38px;border:1px solid #c9cdd1;border-radius:8px;display:flex;align-items:center;gap:8px;padding:0 11px;flex:1;min-width:220px;background:#fff;box-sizing:border-box}.search-box:focus-within{border-color:#005bd3;box-shadow:0 0 0 1px #005bd3}.search-box input{border:0;outline:0;width:100%;font-size:13px;color:#202223;background:transparent}.search-box input::placeholder{color:#8c9196}.select-control{height:38px;border:1px solid #c9cdd1;border-radius:8px;background:#fff;padding:0 32px 0 10px;font-size:13px;color:#202223;min-width:160px;outline:0}.select-control:focus{border-color:#005bd3;box-shadow:0 0 0 1px #005bd3}.filter-button,.clear-button{height:38px;border:1px solid #c9cdd1;border-radius:8px;background:#fff;padding:0 12px;display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:550;cursor:pointer;color:#202223;white-space:nowrap}.filter-button:hover,.clear-button:hover{background:#f6f6f7}.filter-count{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e3efff;color:#005bd3;display:inline-grid;place-items:center;font-size:10px;font-weight:700}.clear-button{margin-left:auto;color:#616161}.filter-popover{position:absolute;right:12px;top:58px;width:300px;background:#fff;border:1px solid #dfe3e8;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:14px;z-index:20}.filter-heading{font-size:13px;font-weight:650;margin-bottom:10px}.filter-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}.filter-field label{font-size:11px;font-weight:600;color:#616161}.filter-field select{height:34px;border:1px solid #c9cdd1;border-radius:7px;padding:0 8px;font-size:12px;background:#fff}.filter-footer{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #edf0f2;padding-top:10px;margin-top:4px}
        .table-card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;overflow:visible;box-shadow:0 1px 1px rgba(0,0,0,.03)}.table-scroll{overflow-x:auto;border-radius:10px}.customer-table{width:100%;border-collapse:collapse;table-layout:fixed}.customer-table th{background:#f6f7f8;color:#6d7175;text-transform:uppercase;letter-spacing:.035em;font-size:10px;line-height:14px;font-weight:650;text-align:left;padding:10px 12px;border-bottom:1px solid #e3e5e7}.customer-table td{padding:10px 12px;border-bottom:1px solid #edf0f2;font-size:12px;line-height:17px;color:#303030;vertical-align:middle}.customer-table tbody tr:hover{background:#fafbfb}.customer-table th:nth-child(1){width:20%}.customer-table th:nth-child(2){width:18%}.customer-table th:nth-child(3){width:12%}.customer-table th:nth-child(4){width:7%}.customer-table th:nth-child(5){width:12%}.customer-table th:nth-child(6){width:11%}.customer-table th:nth-child(7){width:13%}.customer-table th:nth-child(8){width:7%}.customer-cell{display:flex;align-items:center;gap:9px;min-width:0}.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#eaf2ff;color:#2161c5;font-size:11px;font-weight:700;flex:0 0 32px}.customer-main{min-width:0}.customer-name{font-size:12px;line-height:16px;font-weight:650;color:#202223;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none}.customer-email{font-size:11px;line-height:15px;color:#6d7175;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.customer-tag{display:inline-flex;margin-left:6px;padding:2px 6px;border-radius:5px;background:#eef4ff;color:#2161c5;font-size:9px;font-weight:650;vertical-align:middle}.muted{color:#6d7175}.orders-cell,.spent-cell{font-weight:550}.status-cell{text-align:left}.status-badge{display:inline-flex;align-items:center;justify-content:flex-start;gap:5px;padding:4px 8px;border-radius:6px;font-size:10px;line-height:13px;font-weight:650;white-space:nowrap}.status-badge.synced{background:#e3f7ed;color:#008060}.status-badge.pending{background:#fff2df;color:#a66a00}.status-badge.error{background:#fde8e8;color:#d82c0d}.status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 6px}.action-cell{text-align:center}.action-wrap{position:relative;display:inline-block}.more-button{width:34px;height:34px;padding:0;border:1px solid #d9dde1;background:#fff;border-radius:8px;display:grid;place-items:center;cursor:pointer;color:#202223}.more-button:hover{background:#f6f6f7}.more-dots{display:flex;align-items:center;justify-content:center;gap:3px;height:100%;font-size:16px;line-height:1;font-weight:700;letter-spacing:0}.more-dots span{display:block;width:3px;height:3px;border-radius:50%;background:#202223}.action-menu{position:absolute;right:0;top:40px;width:190px;background:#fff;border:1px solid #dfe3e8;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:5px;z-index:100}.action-menu button{width:100%;height:34px;border:0;background:#fff;border-radius:6px;text-align:left;padding:0 9px;font-size:12px;cursor:pointer;color:#202223}.action-menu button:hover{background:#f6f6f7}.pagination{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;gap:12px}.pagination-summary{font-size:12px;color:#616161}.pagination-actions{display:flex;gap:7px}.empty-state{padding:44px 20px;text-align:center;color:#6d7175;font-size:13px}.banner{margin-bottom:12px;border-radius:8px;padding:10px 12px;border:1px solid #b7e5d2;background:#f1fbf6;color:#006e52;font-size:12px}.banner.error{border-color:#f0b8b8;background:#fff4f4;color:#b42318}.connect-note{background:#fff8e6;border:1px solid #f0dfad;border-radius:8px;padding:12px;font-size:13px;color:#614a00;margin-bottom:12px}
        @media(max-width:1000px){.customers-page{width:92%}.stats-grid{grid-template-columns:repeat(2,1fr)}.toolbar{flex-wrap:wrap}.search-box{flex-basis:100%}.clear-button{margin-left:0}.customer-table{min-width:980px}}@media(max-width:640px){.customers-page{width:calc(100% - 24px)}.customers-header{flex-direction:column}.customers-actions{width:100%}.stats-grid{grid-template-columns:1fr}.customer-table{min-width:980px}}
      `}</style>

      <div className="customers-page">
        <div className="customers-header"><div><h1 className="customers-title">Customers</h1><p className="customers-subtitle">Manage and sync your Shopify customers with Zoho Books</p></div><div className="customers-actions"><Form method="get"><s-button type="submit" icon="refresh" loading={isRefreshing}>Refresh</s-button></Form><Form method="post"><input type="hidden" name="intent" value="sync-now" /><s-button variant="primary" type="submit" icon="refresh" loading={isBulkSyncing} disabled={!connected}>Sync Customers</s-button></Form></div></div>
        {!connected && <div className="connect-note">Connect your Zoho Books organization on the <s-link href="/app/settings">Settings</s-link> page before syncing customers.</div>}
        {actionData?.message && <div className={`banner ${actionData.ok ? "" : "error"}`}>{actionData.message}</div>}
        {latestLog && showLog && <div className="banner">Last sync: {formatDate(latestLog.completed_at || latestLog.started_at)} — {formatCount(latestLog.records_processed)} processed, {formatCount(latestLog.records_success)} succeeded, {formatCount(latestLog.records_failed)} failed.</div>}

        <div className="stats-grid">
          <div className="stat-card"><div className="stat-top"><span className="stat-label">Customers on page</span><span className="stat-icon"><s-icon type="person" tone="info"></s-icon></span></div><div className="stat-number">{formatCount(customers.length)}</div><div className="stat-caption">Currently loaded from Shopify</div></div>
          <div className="stat-card"><div className="stat-top"><span className="stat-label">Synced to Zoho</span><span className="stat-icon"><s-icon type="check-circle" tone="success"></s-icon></span></div><div className="stat-number">{formatCount(syncedCount)}</div><div className="stat-caption">Customers successfully synced</div></div>
          <div className="stat-card"><div className="stat-top"><span className="stat-label">Not Synced</span><span className="stat-icon"><s-icon type="clock" tone="caution"></s-icon></span></div><div className="stat-number">{formatCount(pendingCount)}</div><div className="stat-caption">Pending synchronization</div></div>
          <div className="stat-card"><div className="stat-top"><span className="stat-label">Sync Errors</span><span className="stat-icon"><s-icon type="alert-circle" tone="critical"></s-icon></span></div><div className="stat-number">{formatCount(errorCount)}</div><div className="stat-caption">Failed customer records</div></div>
        </div>

        <div className="toolbar">
          <label className="search-box"><s-icon type="search"></s-icon><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customers by name, email, phone or tag" /></label>
          <select className="select-control" value={syncFilter} onChange={(event) => setSyncFilter(event.target.value)}><option value="all">Sync Status · All</option><option value="synced">Synced</option><option value="not-synced">Not synced</option><option value="error">Sync error</option></select>
          <select className="select-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Customer Status · All</option><option value="ENABLED">Enabled</option><option value="DISABLED">Disabled</option><option value="INVITED">Invited</option><option value="DECLINED">Declined</option></select>
          <button className="filter-button" type="button" onClick={() => setMoreFiltersOpen((value) => !value)}><s-icon type="filter"></s-icon>More filters{activeMoreFilters > 0 && <span className="filter-count">{activeMoreFilters}</span>}</button>
          {hasActiveFilters && <button className="clear-button" type="button" onClick={clearFilters}>Clear all</button>}
          {moreFiltersOpen && <div className="filter-popover"><div className="filter-heading">More filters</div><div className="filter-field"><label>Email</label><select value={emailFilter} onChange={(event) => setEmailFilter(event.target.value)}><option value="all">All customers</option><option value="with">With email</option><option value="without">Without email</option></select></div><div className="filter-field"><label>Phone</label><select value={phoneFilter} onChange={(event) => setPhoneFilter(event.target.value)}><option value="all">All customers</option><option value="with">With phone</option><option value="without">Without phone</option></select></div><div className="filter-field"><label>Tags</label><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="all">All customers</option><option value="with">With tags</option><option value="without">Without tags</option></select></div><div className="filter-footer"><button className="clear-button" type="button" onClick={clearFilters}>Clear</button><button className="filter-button" type="button" onClick={() => setMoreFiltersOpen(false)}>Done</button></div></div>}
        </div>

        <div className="table-card">
          {filteredCustomers.length === 0 ? <div className="empty-state">No customers match the selected filters.</div> : <div className="table-scroll"><table className="customer-table"><thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th>Orders</th><th>Total Spent</th><th>Sync Status</th><th>Last Synced</th><th>Action</th></tr></thead><tbody>
            {filteredCustomers.map((customer) => {
              const mapping = mappings[customer.id];
              const status = !mapping ? "pending" : mapping.status === "error" ? "error" : "synced";
              const label = status === "synced" ? "Synced" : status === "error" ? "Sync error" : "Not synced";
              return <tr key={customer.id}><td><div className="customer-cell"><span className="avatar">{initials(customer)}</span><div className="customer-main"><a className="customer-name" href={`shopify://admin/customers/${shopifyNumericId(customer.id)}`} target="_top">{fullName(customer)}</a>{customer.tags?.[0] && <span className="customer-tag">{customer.tags[0]}</span>}</div></div></td><td><span className="customer-email">{customer.email || "No email"}</span></td><td>{customer.phone || <span className="muted">—</span>}</td><td className="orders-cell">{formatCount(customer.numberOfOrders)}</td><td className="spent-cell">{formatCurrency(customer.amountSpent, customer.amountSpentCurrency)}</td><td className="status-cell"><span className={`status-badge ${status}`}><span className="status-dot"></span>{label}</span></td><td className="muted">{formatDate(mapping?.lastSyncedAt)}</td><td className="action-cell"><div className="action-wrap"><button className="more-button" type="button" aria-label={`Actions for ${fullName(customer)}`} onClick={() => setOpenMenu((current) => current === customer.id ? null : customer.id)}><span className="more-dots" aria-hidden="true"><span></span><span></span><span></span></span></button>{openMenu === customer.id && <div className="action-menu"><button type="button" onClick={() => setOpenMenu(null)}><a href={`shopify://admin/customers/${shopifyNumericId(customer.id)}`} target="_top" style={{color:"inherit",textDecoration:"none",display:"block"}}>View in Shopify</a></button>{connected && <Form method="post" onSubmit={() => setOpenMenu(null)}><input type="hidden" name="intent" value="sync-customer" /><input type="hidden" name="customerId" value={customer.id} /><button type="submit" disabled={Boolean(syncingCustomerId)}>{syncingCustomerId === customer.id ? "Syncing customer…" : "Sync customer"}</button></Form>}</div>}</div></td></tr>;
            })}
          </tbody></table></div>}
          <div className="pagination"><div className="pagination-summary">Showing {filteredCustomers.length} of {customers.length} customers on this page</div><div className="pagination-actions"><s-button disabled={!pageInfo.hasPreviousPage} href={pageInfo.hasPreviousPage ? `?before=${encodeURIComponent(pageInfo.startCursor)}` : undefined}>Previous</s-button><s-button disabled={!pageInfo.hasNextPage} href={pageInfo.hasNextPage ? `?after=${encodeURIComponent(pageInfo.endCursor)}` : undefined}>Next</s-button></div></div>
        </div>
      </div>
    </s-page>
  );
}
