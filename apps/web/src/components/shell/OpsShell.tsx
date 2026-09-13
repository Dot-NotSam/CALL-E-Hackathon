"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Octagon } from "lucide-react";
import { CommandBar, useKillSwitch } from "./CommandBar";
import { NavRail, NavStrip } from "./Navigation";
import { useAuth } from "@/lib/auth/auth-context";

export function OpsShell({ children }: { children: React.ReactNode }) {
  const killSwitch = useKillSwitch();
  const { user, role, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
      return;
    }

    if (!loading && user) {
      // Auto-update rendered page route when role changes
      if (role === "ADMIN" && pathname !== "/ops/admin" && pathname !== "/admin") {
        router.push("/ops/admin");
      } else if (role === "DISTRIBUTOR" && (pathname === "/ops/admin" || pathname === "/admin")) {
        router.push("/ops");
      }
    }
  }, [user, role, loading, pathname, router]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas">
      <CommandBar killSwitch={killSwitch} />

      {/* A halted system says so in persistent UI. */}
      {killSwitch.engaged && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-state-critical/40 bg-state-critical/10 px-4 py-2"
        >
          <Octagon className="h-3.5 w-3.5 shrink-0 text-state-critical" aria-hidden />
          <p className="text-xs text-state-critical">
            <span className="font-medium">Outbound calling is halted.</span> In-flight calls were
            stopped and no scenario can be triggered until the kill switch is released.
          </p>
        </div>
      )}

      <NavStrip />

      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
