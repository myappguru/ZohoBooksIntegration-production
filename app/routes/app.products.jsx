import { useMemo, useState } from "react";
import { Form, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { getConnectionForShopDomain, getValidAccessToken } from "../models/zohoConnection.server";
import { getAppSettings } from "../models/appSettings.server";
import { getProductMappings, PRODUCTS_QUERY, normalizeProductNode, runProductSync, syncProductToZoho } from "../models/productSync.server";
import { getLatestSyncLog } from "../models/syncLog.server";

const PAGE_SIZE = 20;
const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductById($id: ID!) {
    product(id: $id) { id title status description featuredMedia { preview { image { url altText } } } variants(first: 50) { edges { node { id title sku price inventoryQuantity } } } }
  }
`;

function shopifyNumericId(gid) { return gid ? gid.split("/").pop() : null; }
async function fetchProductsPage(admin, { after, before } = {}) {
  const variables = before ? { last: PAGE_SIZE, before } : { first: PAGE_SIZE, after: after || null };
  const response = await admin.graphql(PRODUCTS_QUERY, { variables });
  const json = await response.json();
  return { products: (json.data?.products?.edges || []).map(({ node }) => normalizeProductNode(node)), pageInfo: json.data?.products?.pageInfo || { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
}
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  const url = new URL(request.url);
  const { products, pageInfo } = await fetchProductsPage(admin, { after: url.searchParams.get("after") || undefined, before: url.searchParams.get("before") || undefined });
  const mappings = connection ? await getProductMappings(shop.id) : {};
  const latestLog = connection ? await getLatestSyncLog(shop.id, "product") : null;
  return { connected: Boolean(connection), products, pageInfo, mappings, latestLog };
};
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  if (!connection) return null;
  const token = await getValidAccessToken(shop.id).catch((error) => { console.error("Failed to get a valid Zoho access token", error); return null; });
  if (!token) return null;
  const zohoAuth = { accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id };
  if (intent === "sync-now") { await runProductSync({ admin, shop, zohoAuth }); return null; }
  if (intent === "sync-product") {
    const productId = formData.get("productId");
    if (!productId) return null;
    const response = await admin.graphql(PRODUCT_BY_ID_QUERY, { variables: { id: productId } });
    const json = await response.json();
    const product = json.data?.product;
    if (!product) return null;
    const mappings = await getProductMappings(shop.id);
    const appSettings = await getAppSettings(shop.id);
    await syncProductToZoho({ shopId: shop.id, admin, zohoAuth, product: normalizeProductNode(product), mappings, inventoryAccountId: appSettings.accountSettings?.inventoryAccountId });
  }
  return null;
};
function formatCount(value) { return new Intl.NumberFormat().format(value || 0); }
function formatPrice(value) { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value || 0)); }
function formatDate(value) { return value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—"; }
function getVariantSummary(product) { const variants = product.variants || []; return { variants, quantity: variants.reduce((total, variant) => total + Number(variant.inventoryQuantity || 0), 0) }; }

export default function ProductsPage() {
  const { connected, products, pageInfo, mappings, latestLog } = useLoaderData();
  const navigation = useNavigation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [inventoryFilter, setInventoryFilter] = useState("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [productStatusFilter, setProductStatusFilter] = useState("all");
  const [skuFilter, setSkuFilter] = useState("all");
  const [variantFilter, setVariantFilter] = useState("all");
  const [openActionId, setOpenActionId] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const showLog = useAutoDismiss(latestLog?.id);
  const isSyncing = navigation.state === "submitting" && navigation.formData?.get("intent") === "sync-now";
  const syncingProductId = navigation.state === "submitting" && navigation.formData?.get("intent") === "sync-product" ? navigation.formData?.get("productId") : null;
  const clearMoreFilters = () => { setProductStatusFilter("all"); setSkuFilter("all"); setVariantFilter("all"); };
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((product) => {
      const variants = product.variants || [];
      const states = variants.map((variant) => mappings[variant.id]);
      const hasError = states.some((mapping) => mapping?.status === "error");
      const hasSynced = states.some((mapping) => mapping?.status === "synced");
      const hasUnsynced = variants.some((variant) => !mappings[variant.id]);
      const quantity = variants.reduce((total, variant) => total + Number(variant.inventoryQuantity || 0), 0);
      const matchesSearch = !query || [product.title, product.handle, ...variants.map((variant) => `${variant.sku || ""} ${variant.title || ""}`)].some((value) => String(value || "").toLowerCase().includes(query));
      const matchesStatus = statusFilter === "all" || (statusFilter === "synced" && hasSynced && !hasError) || (statusFilter === "unsynced" && hasUnsynced) || (statusFilter === "error" && hasError);
      const matchesInventory = inventoryFilter === "all" || (inventoryFilter === "in-stock" && quantity > 0) || (inventoryFilter === "out-of-stock" && quantity <= 0);
      const matchesProductStatus = productStatusFilter === "all" || product.status?.toLowerCase() === productStatusFilter;
      const hasSku = variants.some((variant) => Boolean(variant.sku));
      const matchesSku = skuFilter === "all" || (skuFilter === "with-sku" && hasSku) || (skuFilter === "without-sku" && !hasSku);
      const matchesVariants = variantFilter === "all" || (variantFilter === "single" && variants.length === 1) || (variantFilter === "multiple" && variants.length > 1);
      return matchesSearch && matchesStatus && matchesInventory && matchesProductStatus && matchesSku && matchesVariants;
    });
  }, [products, mappings, search, statusFilter, inventoryFilter, productStatusFilter, skuFilter, variantFilter]);
  const stats = useMemo(() => {
    let synced = 0, unsynced = 0, errors = 0;
    products.forEach((product) => (product.variants || []).forEach((variant) => { const mapping = mappings[variant.id]; if (mapping?.status === "error") errors += 1; else if (mapping?.status === "synced") synced += 1; else unsynced += 1; }));
    return { products: products.length, synced, unsynced, errors };
  }, [products, mappings]);
  const activeMoreFilterCount = [productStatusFilter !== "all", skuFilter !== "all", variantFilter !== "all"].filter(Boolean).length;

  return (
    <s-page heading="Products" inlineSize="large">
      <style>{`
        .products-page { width:80%; max-width:1260px; margin:0 auto; padding:0 0 24px; box-sizing:border-box; color:#202223; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
        .products-header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:16px; }
        .products-title { margin:0; font-size:20px; line-height:26px; font-weight:650; letter-spacing:-.01em; }
        .products-subtitle { margin:3px 0 0; color:#616161; font-size:15px; line-height:21px; }
        .products-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .products-card { background:#fff; border:1px solid #dfe3e8; border-radius:10px; box-shadow:0 1px 1px rgba(0,0,0,.03); overflow:visible; }
        .stats-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:12px; }
        .stat-card { padding:14px 16px; min-height:108px; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; }
        .stat-top { display:flex; justify-content:space-between; align-items:center; gap:12px; }
        .stat-label { font-size:12px; line-height:16px; font-weight:600; color:#303030; }
        .stat-icon { width:38px; height:38px; border-radius:9px; display:grid; place-items:center; background:#eef6ff; }
        .stat-icon s-icon { width:20px; height:20px; }
        .stat-card:nth-child(2) .stat-icon { background:#e8f7ed; }
        .stat-card:nth-child(3) .stat-icon { background:#fff5e5; }
        .stat-card:nth-child(4) .stat-icon { background:#f3ebff; }
        .stat-number { font-size:26px; line-height:30px; font-weight:650; margin-top:4px; letter-spacing:-.02em; }
        .stat-caption { color:#6d7175; font-size:13px; line-height:18px; }
        .sync-banner { margin-bottom:12px; }
        .toolbar-card { margin-bottom:12px; }
        .toolbar { padding:12px 14px; display:grid; grid-template-columns:minmax(0,2.1fr) minmax(170px,1fr) minmax(170px,.98fr) auto; gap:10px; align-items:center; }
        .search-box { height:40px; border:1px solid #c9cdd1; border-radius:8px; display:flex; align-items:center; gap:8px; padding:0 12px; background:#fff; box-sizing:border-box; min-width:0; }
        .search-box:focus-within { border-color:#005bd3; box-shadow:0 0 0 1px #005bd3; }
        .search-box s-icon { width:17px; height:17px; flex:0 0 17px; }
        .search-box input { border:0; outline:0; width:100%; font:inherit; color:#202223; font-size:13px; background:transparent; min-width:0; }
        .filter-select { height:40px; border:1px solid #c9cdd1; border-radius:8px; padding:0 10px; background:#fff; color:#303030; font:inherit; font-size:13px; width:100%; }
        .more-filter-wrap { position:relative; }
        .more-filter-panel { position:absolute; z-index:100; top:48px; right:0; width:300px; padding:14px; background:#fff; border:1px solid #dfe3e8; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.12); }
        .more-filter-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; font-size:13px; font-weight:650; }
        .more-filter-group { margin-bottom:12px; }
        .more-filter-label { display:block; margin-bottom:6px; color:#616161; font-size:11px; line-height:15px; font-weight:650; }
        .more-filter-footer { display:flex; justify-content:space-between; align-items:center; padding-top:10px; border-top:1px solid #edf0f2; }
        .clear-filter { border:0; background:none; color:#005bd3; cursor:pointer; font-size:12px; }
        .filter-count { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; padding:0 5px; border-radius:999px; background:#202223; color:#fff; font-size:10px; line-height:18px; margin-left:5px; }
        .table-wrap { overflow-x:auto; }
        .product-table { width:100%; min-width:850px; border-collapse:collapse; table-layout:fixed; }
        .product-table th { text-align:left; background:#f6f7f8; color:#6d7175; padding:10px 14px; font-size:10px; line-height:15px; text-transform:uppercase; letter-spacing:.035em; font-weight:650; border-bottom:1px solid #e5e7e9; }
        .product-table td { padding:11px 14px; border-bottom:1px solid #edf0f2; font-size:13px; line-height:18px; color:#303030; vertical-align:middle; }
        .product-table tr:last-child td { border-bottom:0; }
        .product-table th:nth-child(1), .product-table td:nth-child(1) { width:28%; }
        .product-table th:nth-child(2), .product-table td:nth-child(2) { width:15%; }
        .product-table th:nth-child(3), .product-table td:nth-child(3) { width:11%; }
        .product-table th:nth-child(4), .product-table td:nth-child(4) { width:13%; }
        .product-table th:nth-child(5), .product-table td:nth-child(5) { width:13%; text-align:center; }
        .product-table th:nth-child(6), .product-table td:nth-child(6) { width:14%; }
        .product-table th:nth-child(7), .product-table td:nth-child(7) { width:6%; text-align:right; }
        .product-cell { display:flex; align-items:center; gap:10px; min-width:0; }
        .product-image { width:42px; height:42px; border-radius:7px; border:1px solid #e1e4e6; object-fit:cover; background:#f6f6f7; flex:0 0 42px; }
        .product-image-placeholder { display:grid; place-items:center; color:#8c9196; }
        .product-info { min-width:0; }
        .product-name { display:block; color:#202223; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-decoration:none; }
        .product-name:hover { text-decoration:underline; }
        .product-sub { color:#6d7175; font-size:11px; line-height:16px; margin-top:1px; }
        .sku { font-size:12px; color:#303030; }
        .muted { color:#6d7175; }
        .inventory-number { display:block; font-weight:600; }
        .inventory-label { display:block; font-size:11px; line-height:16px; margin-top:1px; }
        .inventory-good { color:#008060; }
        .inventory-empty { color:#d72c0d; }
        .status-cell { white-space:nowrap; text-align:center; }
        .status-badge { display:inline-flex; align-items:center; justify-content:center; gap:5px; padding:4px 8px; border-radius:6px; font-size:11px; line-height:15px; font-weight:650; white-space:nowrap; }
        .status-synced { background:#e3f7ed; color:#008060; }
        .status-unsynced { background:#fff5e5; color:#b98900; }
        .status-error { background:#fdecea; color:#d72c0d; }
        .status-badge s-icon { display:flex; align-items:center; justify-content:center; flex:0 0 13px; width:13px; height:13px; line-height:0; }
        .status-badge .status-label { display:inline-flex; align-items:center; line-height:15px; }
        .action-wrap { position:relative; display:flex; justify-content:flex-end; }
        .action-button { width:32px; height:32px; border:1px solid #dfe3e8; border-radius:7px; background:#fff; cursor:pointer; display:grid; place-items:center; color:#303030; font-weight:700; letter-spacing:1px; }
        .action-button:hover { background:#f6f7f8; }
        .action-menu { position:absolute; z-index:100; top:38px; right:0; width:190px; padding:6px; background:#fff; border:1px solid #dfe3e8; border-radius:9px; box-shadow:0 8px 24px rgba(0,0,0,.12); }
        .action-menu a,.action-menu button { width:100%; display:flex; align-items:center; gap:8px; padding:9px 10px; border:0; border-radius:6px; background:transparent; color:#202223; text-align:left; text-decoration:none; font:inherit; font-size:12px; cursor:pointer; }
        .action-menu a:hover,.action-menu button:hover { background:#f6f7f8; }
        .action-menu button:disabled { opacity:.5; cursor:not-allowed; }
        .empty-products { padding:44px 20px; text-align:center; color:#6d7175; font-size:13px; }
        .table-footer { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 14px; border-top:1px solid #e5e7e9; color:#6d7175; font-size:13px; line-height:18px; }
        .pagination { display:flex; align-items:center; gap:6px; }
        .sync-note { margin-top:12px; color:#6d7175; font-size:13px; line-height:18px; }
        @media (max-width:1100px) { .products-page{width:90%;} .toolbar{grid-template-columns:minmax(220px,1.5fr) minmax(150px,1fr) minmax(150px,1fr) auto;} }
        @media (max-width:900px) { .products-page{width:100%;} .stats-grid{grid-template-columns:1fr 1fr;} .toolbar{grid-template-columns:1fr 1fr;} .products-header{flex-direction:column;} }
        @media (max-width:620px) { .stats-grid{grid-template-columns:1fr;} .toolbar{grid-template-columns:1fr;} .table-footer{flex-direction:column;align-items:flex-start;} .more-filter-panel{left:0;right:auto;width:min(300px,calc(100vw - 40px));} }
      `}</style>
      <div className="products-page">
        <div className="products-header"><div><h1 className="products-title">Products</h1><p className="products-subtitle">Manage and sync your Shopify products with Zoho Books</p></div><div className="products-actions"><Form method="get" onSubmit={() => setIsRefreshing(true)}><s-button type="submit" icon="refresh" loading={isRefreshing}>Refresh</s-button></Form><Form method="post"><input type="hidden" name="intent" value="sync-now" /><s-button variant="primary" type="submit" icon="refresh" loading={isSyncing} disabled={!connected || isRefreshing}>Sync Products</s-button></Form></div></div>
        {!connected && <div className="sync-banner"><s-banner tone="warning" heading="Zoho Books is not connected">Connect your Zoho Books organization from the <s-link href="/app/settings">Settings</s-link> page before syncing products.</s-banner></div>}
        {latestLog && showLog && <div className="sync-banner"><s-banner heading="Last product sync" tone={latestLog.records_failed > 0 ? "warning" : "success"}>{formatDate(latestLog.completed_at || latestLog.started_at)} — {formatCount(latestLog.records_processed)} processed, {formatCount(latestLog.records_success)} succeeded, {formatCount(latestLog.records_failed)} failed.</s-banner></div>}
        <div className="stats-grid"><div className="products-card stat-card"><div className="stat-top"><span className="stat-label">Products on page</span><span className="stat-icon"><s-icon type="product" tone="info"></s-icon></span></div><div className="stat-number">{formatCount(stats.products)}</div><div className="stat-caption">Currently loaded from Shopify</div></div><div className="products-card stat-card"><div className="stat-top"><span className="stat-label">Synced to Zoho</span><span className="stat-icon"><s-icon type="check-circle" tone="success"></s-icon></span></div><div className="stat-number">{formatCount(stats.synced)}</div><div className="stat-caption">Variants successfully synced</div></div><div className="products-card stat-card"><div className="stat-top"><span className="stat-label">Not Synced</span><span className="stat-icon"><s-icon type="clock" tone="caution"></s-icon></span></div><div className="stat-number">{formatCount(stats.unsynced)}</div><div className="stat-caption">Pending synchronization</div></div><div className="products-card stat-card"><div className="stat-top"><span className="stat-label">Sync Errors</span><span className="stat-icon"><s-icon type="alert-circle" tone="critical"></s-icon></span></div><div className="stat-number">{formatCount(stats.errors)}</div><div className="stat-caption">Failed product variants</div></div></div>
        <div className="products-card toolbar-card"><div className="toolbar"><label className="search-box"><s-icon type="search"></s-icon><input value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Search products by title, SKU, or handle" aria-label="Search products" /></label><select className="filter-select" value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)} aria-label="Filter by sync status"><option value="all">Sync Status · All</option><option value="synced">Sync Status · Synced</option><option value="unsynced">Sync Status · Not Synced</option><option value="error">Sync Status · Errors</option></select><select className="filter-select" value={inventoryFilter} onChange={(event)=>setInventoryFilter(event.target.value)} aria-label="Filter by inventory status"><option value="all">Inventory · All</option><option value="in-stock">Inventory · In stock</option><option value="out-of-stock">Inventory · Out of stock</option></select><div className="more-filter-wrap"><s-button icon="filter" onClick={()=>{setShowMoreFilters((value)=>!value);setOpenActionId(null);}}>More filters{activeMoreFilterCount>0&&<span className="filter-count">{activeMoreFilterCount}</span>}</s-button>{showMoreFilters&&<div className="more-filter-panel"><div className="more-filter-title"><span>More filters</span><s-button variant="tertiary" onClick={()=>setShowMoreFilters(false)}>Close</s-button></div><div className="more-filter-group"><label className="more-filter-label">Product status</label><select className="filter-select" value={productStatusFilter} onChange={(event)=>setProductStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="draft">Draft</option><option value="archived">Archived</option></select></div><div className="more-filter-group"><label className="more-filter-label">SKU</label><select className="filter-select" value={skuFilter} onChange={(event)=>setSkuFilter(event.target.value)}><option value="all">All products</option><option value="with-sku">With SKU</option><option value="without-sku">Without SKU</option></select></div><div className="more-filter-group"><label className="more-filter-label">Variants</label><select className="filter-select" value={variantFilter} onChange={(event)=>setVariantFilter(event.target.value)}><option value="all">All products</option><option value="single">Single variant</option><option value="multiple">Multiple variants</option></select></div><div className="more-filter-footer"><button type="button" className="clear-filter" onClick={clearMoreFilters}>Clear filters</button><s-button variant="primary" onClick={()=>setShowMoreFilters(false)}>Done</s-button></div></div>}</div></div></div>
        <div className="products-card">{visibleProducts.length===0?<div className="empty-products">{products.length===0?"No products found in this store.":"No products match your current search or filters."}</div>:<div className="table-wrap"><table className="product-table"><thead><tr><th>Product</th><th>SKU</th><th>Price</th><th>Inventory</th><th>Sync Status</th><th>Last Synced</th><th>Action</th></tr></thead><tbody>{visibleProducts.map((product)=>{const {quantity,variants}=getVariantSummary(product);const productMappings=variants.map((variant)=>mappings[variant.id]).filter(Boolean);const hasError=productMappings.some((mapping)=>mapping.status==="error");const allSynced=variants.length>0&&variants.every((variant)=>mappings[variant.id]?.status==="synced");const status=hasError?"error":allSynced?"synced":"unsynced";const lastSynced=productMappings.map((mapping)=>mapping.lastSyncedAt).filter(Boolean).sort().pop();const primaryVariant=variants[0];const statusLabel=status==="error"?"Sync error":status==="synced"?"Synced":"Not synced";const isThisProductSyncing=syncingProductId===product.id;return <tr key={product.id}><td><div className="product-cell">{product.imageUrl?<img className="product-image" src={product.imageUrl} alt=""/>:<div className="product-image product-image-placeholder"><s-icon type="image"></s-icon></div>}<div className="product-info"><a className="product-name" href={`shopify://admin/products/${shopifyNumericId(product.id)}`} target="_top">{product.title}</a><div className="product-sub">{variants.length} {variants.length===1?"variant":"variants"} · {product.status}</div></div></div></td><td><span className="sku">{primaryVariant?.sku||<span className="muted">No SKU</span>}</span></td><td>{primaryVariant?formatPrice(primaryVariant.price):"—"}</td><td><span className="inventory-number">{formatCount(quantity)}</span><span className={`inventory-label ${quantity>0?"inventory-good":"inventory-empty"}`}>{quantity>0?"In stock":"Out of stock"}</span></td><td className="status-cell"><span className={`status-badge status-${status}`}><s-icon type={status==="synced"?"check-circle":status==="error"?"alert-circle":"clock"}></s-icon><span className="status-label">{statusLabel}</span></span></td><td className="muted">{formatDate(lastSynced)}</td><td><div className="action-wrap"><button className="action-button" type="button" aria-label={`Actions for ${product.title}`} title="More actions" onClick={()=>{setOpenActionId((value)=>value===product.id?null:product.id);setShowMoreFilters(false);}}>•••</button>{openActionId===product.id&&<div className="action-menu"><a href={`shopify://admin/products/${shopifyNumericId(product.id)}`} target="_top">View in Shopify</a><Form method="post" onSubmit={()=>setOpenActionId(null)}><input type="hidden" name="intent" value="sync-product"/><input type="hidden" name="productId" value={product.id}/><button type="submit" disabled={Boolean(syncingProductId)}>{isThisProductSyncing?"Syncing product…":"Sync this product"}</button></Form></div>}</div></td></tr>;})}</tbody></table></div>}<div className="table-footer"><span>Showing {visibleProducts.length} of {products.length} products on this page</span>{(pageInfo.hasPreviousPage||pageInfo.hasNextPage)&&<div className="pagination"><s-button variant="secondary" disabled={!pageInfo.hasPreviousPage||isRefreshing} href={pageInfo.hasPreviousPage?`?before=${encodeURIComponent(pageInfo.startCursor)}`:undefined}>‹</s-button><span>Current</span><s-button variant="secondary" disabled={!pageInfo.hasNextPage||isRefreshing} href={pageInfo.hasNextPage?`?after=${encodeURIComponent(pageInfo.endCursor)}`:undefined}>›</s-button></div>}</div></div>
        {latestLog&&<div className="sync-note">Last synchronization: {formatDate(latestLog.completed_at||latestLog.started_at)}</div>}
      </div>
    </s-page>
  );
}
