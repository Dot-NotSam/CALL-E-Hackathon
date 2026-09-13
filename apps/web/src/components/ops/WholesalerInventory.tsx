"use client";

/**
 * Wholesaler Inventory Console — Current Warehouse Stock
 *
 * Displays items currently available in the wholesaler's warehouse stock:
 *  - Header metrics: Total SKUs, total units, valuation, low stock alerts
 *  - Search & category filter bar
 *  - Interactive inventory table with stock levels, reserved quantities, unit prices,
 *    and stock adjustments.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Package,
  Boxes,
  TrendingUp,
  AlertTriangle,
  Search,
  RotateCw,
  Plus,
  Minus,
  Building2,
  CheckCircle2,
  Warehouse,
  IndianRupee,
} from "lucide-react";
import type { InventoryItem } from "@/app/api/v1/inventory/route";
import { Panel } from "@/components/ui/Panel";
import { StateChip } from "@/components/ui/StateChip";
import { Button } from "@/components/ui/Button";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth/auth-context";

export function WholesalerInventory() {
  const { profile } = useAuth();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<{
    totalSkus: number;
    totalUnits: number;
    totalValueINR: number;
    lowStockAlerts: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("ALL");
  const [updatingSku, setUpdatingSku] = useState<string | null>(null);

  const fetchInventory = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<{ items: InventoryItem[]; summary: typeof summary }>("/api/v1/inventory")
      .then((res) => {
        setItems(res.items);
        setSummary(res.summary);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load inventory");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

  const handleStockAdjustment = (sku: string, delta: number) => {
    setUpdatingSku(sku);
    apiPost<{ success: boolean; item: InventoryItem }>("/api/v1/inventory", { sku, delta })
      .then(() => fetchInventory())
      .catch(() => {})
      .finally(() => setUpdatingSku(null));
  };

  const categories = ["ALL", ...Array.from(new Set(items.map((i) => i.category)))];

  const filteredItems = items.filter((item) => {
    const matchesSearch =
      item.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.warehouseZone.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCat = selectedCategory === "ALL" || item.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  return (
    <div className="flex flex-col gap-6 p-5 sm:p-8">
      {/* ── Header Section ───────────────────────────────────────── */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow flex items-center gap-1.5 text-lilac">
            <Warehouse className="h-3.5 w-3.5" />
            {profile?.wholesalerName || "Northgate Wholesale"} · Central Warehouse Stock
          </p>
          <h1 className="display mt-2 text-display-s text-ink">
            Current <em>Inventory</em>
          </h1>
          <p className="mt-2 max-w-[60ch] text-sm text-ink-dim">
            Real-time warehouse stock levels, allocated quantities for vendor orders, unit valuations, and automated low-stock warnings.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="md" onClick={fetchInventory} disabled={loading}>
            <RotateCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh Stock
          </Button>
        </div>
      </header>

      {/* ── Metrics Rail ─────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-line bg-panel p-4 flex items-center gap-4">
          <div className="rounded-full bg-lilac/20 p-3 text-lilac">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <p className="micro">Total Product SKUs</p>
            <p className="text-2xl font-bold text-ink mt-0.5">{summary ? summary.totalSkus : "—"}</p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-panel p-4 flex items-center gap-4">
          <div className="rounded-full bg-state-info/20 p-3 text-state-info">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <p className="micro">Total Units in Stock</p>
            <p className="text-2xl font-bold text-ink mt-0.5 font-mono">
              {summary ? summary.totalUnits.toLocaleString("en-IN") : "—"}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-panel p-4 flex items-center gap-4">
          <div className="rounded-full bg-state-success/20 p-3 text-state-success">
            <IndianRupee className="h-5 w-5" />
          </div>
          <div>
            <p className="micro">Inventory Valuation</p>
            <p className="text-2xl font-bold text-ink mt-0.5 font-mono">
              {summary ? `₹${(summary.totalValueINR / 100000).toFixed(2)} L` : "—"}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-panel p-4 flex items-center gap-4">
          <div className="rounded-full bg-state-warning/20 p-3 text-state-warning">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <p className="micro">Low Stock Warnings</p>
            <p className="text-2xl font-bold text-state-warning mt-0.5">
              {summary ? summary.lowStockAlerts : "—"}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-state-critical/40 bg-state-critical/8 px-5 py-3 text-sm text-state-critical">
          {error}
        </div>
      )}

      {/* ── Inventory Table Panel ─────────────────────────────────── */}
      <Panel
        label="Warehouse Stock Catalog"
        bodyClassName="p-0 overflow-x-auto"
        right={
          <div className="flex flex-wrap items-center gap-3">
            {/* Category Filter Pills */}
            <div className="flex items-center gap-1 overflow-x-auto">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                    selectedCategory === cat
                      ? "bg-lilac text-on-lilac font-semibold"
                      : "bg-stone/50 text-ink-dim hover:text-ink hover:bg-stone/80"
                  }`}
                >
                  {cat === "ALL" ? "All Categories" : cat}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative min-w-[200px]">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-ink-faint" />
              <input
                type="text"
                placeholder="Search SKU or item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 w-full rounded-md border border-line-strong bg-elevated pl-8 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-lilac focus:outline-none"
              />
            </div>
          </div>
        }
      >
        <table className="w-full text-left text-xs text-ink border-collapse">
          <thead>
            <tr className="border-b border-line bg-stone/40 micro text-ink-dim">
              <th className="py-3.5 px-5 font-semibold">SKU & Item Description</th>
              <th className="py-3.5 px-4 font-semibold">Category & Zone</th>
              <th className="py-3.5 px-4 font-semibold">Available / Total Stock</th>
              <th className="py-3.5 px-4 font-semibold">Unit Price</th>
              <th className="py-3.5 px-4 font-semibold">Total Stock Value</th>
              <th className="py-3.5 px-4 font-semibold">Stock Status</th>
              <th className="py-3.5 px-5 font-semibold text-right">Quick Stock Adjust</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading && (
              <tr>
                <td colSpan={7} className="py-12 text-center text-ink-dim text-xs">
                  Loading warehouse inventory...
                </td>
              </tr>
            )}

            {!loading && filteredItems.length === 0 && (
              <tr>
                <td colSpan={7} className="py-12 text-center text-ink-dim text-xs">
                  No inventory items match your search.
                </td>
              </tr>
            )}

            {!loading &&
              filteredItems.map((item) => {
                const stockPercent = Math.min(100, Math.round((item.availableQty / item.totalStock) * 100));

                return (
                  <tr key={item.sku} className="hover:bg-stone/50 transition-colors group">
                    {/* SKU & Description */}
                    <td className="py-4 px-5 align-middle">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-sm text-ink group-hover:text-ink transition-colors">
                          {item.description}
                        </span>
                        <span className="font-mono text-[11px] text-ink-faint">
                          SKU: {item.sku}
                        </span>
                      </div>
                    </td>

                    {/* Category & Zone */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-0.5 text-xs text-ink-dim">
                        <span className="font-medium text-ink">{item.category}</span>
                        <span className="text-[11px] text-ink-faint flex items-center gap-1">
                          <Warehouse className="h-3 w-3 shrink-0" />
                          {item.warehouseZone}
                        </span>
                      </div>
                    </td>

                    {/* Available / Total Stock */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-1 min-w-[140px]">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-ink font-mono">
                            {item.availableQty.toLocaleString("en-IN")} {item.unit}
                          </span>
                          <span className="text-[10px] text-ink-faint">
                            of {item.totalStock.toLocaleString("en-IN")} total
                          </span>
                        </div>
                        {/* Progress Bar */}
                        <div className="h-1.5 w-full rounded-full bg-stone overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              item.status === "LOW_STOCK" ? "bg-state-warning" : "bg-lilac"
                            }`}
                            style={{ width: `${stockPercent}%` }}
                          />
                        </div>
                        {item.reservedQty > 0 && (
                          <span className="text-[10px] text-ink-faint">
                            ({item.reservedQty} {item.unit} allocated to open orders)
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Unit Price */}
                    <td className="py-4 px-4 align-middle font-mono text-xs text-ink-dim">
                      ₹{item.unitPrice.toLocaleString("en-IN")} / {item.unit.slice(0, -1)}
                    </td>

                    {/* Total Stock Value */}
                    <td className="py-4 px-4 align-middle font-mono text-xs font-bold text-ink">
                      ₹{(item.totalStock * item.unitPrice).toLocaleString("en-IN")}
                    </td>

                    {/* Stock Status */}
                    <td className="py-4 px-4 align-middle">
                      <StateChip
                        state={item.status === "IN_STOCK" ? "success" : "warning"}
                        size="sm"
                        className="text-[11px]"
                      >
                        {item.status === "IN_STOCK" ? "In Stock" : "Low Stock Alert"}
                      </StateChip>
                    </td>

                    {/* Quick Stock Adjust Buttons */}
                    <td className="py-4 px-5 align-middle text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleStockAdjustment(item.sku, -10)}
                          disabled={updatingSku === item.sku || item.totalStock <= 0}
                          title="Deduct 10 units"
                          className="h-7 w-7 rounded border border-line bg-panel hover:bg-stone flex items-center justify-center text-ink transition-colors disabled:opacity-40"
                        >
                          <Minus className="h-3 w-3" />
                        </button>

                        <button
                          onClick={() => handleStockAdjustment(item.sku, 50)}
                          disabled={updatingSku === item.sku}
                          title="Add 50 units"
                          className="h-7 w-7 rounded border border-line bg-panel hover:bg-stone flex items-center justify-center text-ink transition-colors disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
