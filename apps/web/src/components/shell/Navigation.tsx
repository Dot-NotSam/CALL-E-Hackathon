"use client";

/**
 * Section navigation, strictly isolated by user role.
 *
 * - ADMIN role sees ONLY Admin Console routes.
 * - DISTRIBUTOR / WHOLESALER role sees ONLY Wholesaler routes.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { History, LayoutList, Package, Shield, UserCog, UserPlus, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth/auth-context";

interface NavRoute {
  href: string;
  label: string;
  icon: LucideIcon;
  built: boolean;
  roleRequired: "ADMIN" | "WHOLESALER";
}

export const ADMIN_ROUTES: NavRoute[] = [
  { href: "/ops/admin", label: "Admin Console", icon: Shield, built: true, roleRequired: "ADMIN" },
];

export const WHOLESALER_ROUTES: NavRoute[] = [
  { href: "/ops", label: "Dashboard", icon: LayoutList, built: true, roleRequired: "WHOLESALER" },
  { href: "/ops/inventory", label: "Inventory", icon: Package, built: true, roleRequired: "WHOLESALER" },
  { href: "/ops/simulator", label: "Add Customer", icon: UserPlus, built: true, roleRequired: "WHOLESALER" },
  { href: "/ops/profile", label: "Profile", icon: UserCog, built: true, roleRequired: "WHOLESALER" },
];

const NOT_BUILT = "Not in this build — scoped out of the P0 pass";

function isActive(pathname: string, href: string): boolean {
  return href === "/ops" ? pathname === "/ops" : pathname.startsWith(href);
}

function NavItem({
  route,
  active,
  orientation,
}: {
  route: NavRoute;
  active: boolean;
  orientation: "rail" | "strip";
}) {
  const Icon = route.icon;
  const shared =
    orientation === "rail"
      ? "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm"
      : "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs";
  const iconSize = orientation === "rail" ? "h-4 w-4" : "h-3.5 w-3.5";

  if (!route.built) {
    return (
      <span
        aria-disabled
        title={NOT_BUILT}
        className={cn(shared, "cursor-not-allowed text-ink-faint/60")}
      >
        <Icon className={cn(iconSize, "shrink-0")} aria-hidden />
        <span className="truncate">{route.label}</span>
        {orientation === "rail" && (
          <span className="micro ml-auto shrink-0">soon</span>
        )}
      </span>
    );
  }

  return (
    <Link
      href={route.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        shared,
        "transition-colors",
        active
          ? "bg-lilac font-semibold text-on-lilac"
          : "text-ink-dim hover:bg-stone/60 hover:text-ink",
      )}
    >
      <Icon className={cn(iconSize, "shrink-0")} aria-hidden />
      <span className="truncate">{route.label}</span>
    </Link>
  );
}

/** The vertical rail, shown from lg up. */
export function NavRail() {
  const pathname = usePathname();
  const { role } = useAuth();

  const visibleRoutes = role === "ADMIN" ? ADMIN_ROUTES : WHOLESALER_ROUTES;

  return (
    <nav
      aria-label="Sections"
      className="hidden w-[208px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line px-3 py-4 lg:flex"
    >
      {visibleRoutes.map((route) => (
        <NavItem
          key={route.href}
          route={route}
          active={isActive(pathname, route.href)}
          orientation="rail"
        />
      ))}

      <div className="mt-auto space-y-2 rounded-lg bg-stone/50 p-3">
        <p className="micro">{role === "ADMIN" ? "Platform Admin" : "Safety"}</p>
        <p className="text-xs leading-relaxed text-ink-dim">
          {role === "ADMIN"
            ? "Super Admin Mode. Platform monitoring and CALL-E analytics active."
            : "Consented business contacts only, within working hours."}
        </p>
      </div>
    </nav>
  );
}

/** The horizontal strip, shown below lg where the rail is hidden. */
export function NavStrip() {
  const pathname = usePathname();
  const { role } = useAuth();

  const visibleRoutes = role === "ADMIN" ? ADMIN_ROUTES : WHOLESALER_ROUTES;

  return (
    <nav
      aria-label="Sections"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 lg:hidden"
    >
      {visibleRoutes.map((route) => (
        <NavItem
          key={route.href}
          route={route}
          active={isActive(pathname, route.href)}
          orientation="strip"
        />
      ))}
    </nav>
  );
}
