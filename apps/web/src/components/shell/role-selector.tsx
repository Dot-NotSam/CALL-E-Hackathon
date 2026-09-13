"use client";

import { useState, useEffect } from "react";
import { Shield, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type RoleOption = "ADMIN" | "DISTRIBUTOR";

interface RoleSelectorProps {
  currentRole?: string;
  onRoleChange?: (role: RoleOption) => void;
  className?: string;
}

const ROLES: { id: RoleOption; label: string; icon: typeof Shield; color: string }[] = [
  { id: "ADMIN", label: "Admin", icon: Shield, color: "text-amber-600 bg-amber-500/10 border-amber-500/20" },
  { id: "DISTRIBUTOR", label: "Wholesaler", icon: Building2, color: "text-blue-600 bg-blue-500/10 border-blue-500/20" },
];

export function RoleSelector({ currentRole: propRole, onRoleChange, className }: RoleSelectorProps) {
  const [role, setRole] = useState<RoleOption>(
    propRole === "ADMIN" ? "ADMIN" : "DISTRIBUTOR"
  );

  useEffect(() => {
    if (propRole && (propRole === "ADMIN" || propRole === "DISTRIBUTOR")) {
      setRole(propRole as RoleOption);
    } else {
      const saved = localStorage.getItem("sentinel_user_role") as RoleOption;
      if (saved && ["ADMIN", "DISTRIBUTOR"].includes(saved)) {
        setRole(saved);
      }
    }
  }, [propRole]);

  const handleSelect = (newRole: RoleOption) => {
    setRole(newRole);
    localStorage.setItem("sentinel_user_role", newRole);
    onRoleChange?.(newRole);
  };

  return (
    <div className={cn("flex items-center gap-1 bg-stone-100 p-1 rounded-lg border border-line", className)}>
      <span className="text-[11px] font-medium text-ink-dim px-2 hidden sm:inline">Role:</span>
      {ROLES.map((r) => {
        const Icon = r.icon;
        const active = role === r.id;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => handleSelect(r.id)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer",
              active
                ? `${r.color} border shadow-xs font-semibold`
                : "text-ink-dim hover:text-ink hover:bg-stone/80"
            )}
            title={`Switch view to ${r.label}`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{r.label}</span>
          </button>
        );
      })}
    </div>
  );
}
