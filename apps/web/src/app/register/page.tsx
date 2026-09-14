"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserPlus, ArrowLeft, AlertCircle, Building2, Shield, Lock, Mail, User } from "lucide-react";
import { useAuth } from "@/lib/auth/auth-context";
import { BrandMark } from "@/components/ui/BrandMark";
import type { UserRole } from "@/lib/db/orders-repository";
import { cn } from "@/lib/utils";

export default function RegisterPage() {
  const router = useRouter();
  const { signUp } = useAuth();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("DISTRIBUTOR");
  const [orgId, setOrgId] = useState("org-northgate");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRoleSelect = (newRole: UserRole) => {
    setRole(newRole);
    if (newRole === "DISTRIBUTOR") setOrgId("org-northgate");
    if (newRole === "ADMIN") setOrgId("org-northgate");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }

    setLoading(true);

    try {
      const res = await signUp(email, password, fullName, role, orgId);
      if (res.error) {
        setError(res.error);
      } else {
        router.push("/ops");
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-center items-center bg-stone-50 px-4 py-12">
      <div className="w-full max-w-lg space-y-6 bg-white p-8 rounded-2xl border border-line shadow-sm">
        <div className="flex flex-col items-center text-center space-y-2">
          <BrandMark />
          <h1 className="text-2xl font-serif font-semibold text-ink mt-3">Create an Account</h1>
          <p className="text-sm text-ink-dim">
            Register for Role-Based Access on Market Buddy
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700 border border-red-200 text-xs">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Role Choice */}
          <div>
            <label className="block text-xs font-semibold text-ink mb-2">Select Your Role</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleRoleSelect("DISTRIBUTOR")}
                className={cn(
                  "flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer",
                  role === "DISTRIBUTOR"
                    ? "border-blue-500 bg-blue-50/50 text-blue-700 font-semibold shadow-xs"
                    : "border-line text-ink-dim hover:bg-stone-50"
                )}
              >
                <Building2 className="h-5 w-5 mb-1 text-blue-600" />
                <span className="text-xs">Wholesaler</span>
                <span className="micro text-ink-faint">Standard Operations</span>
              </button>

              <button
                type="button"
                onClick={() => handleRoleSelect("ADMIN")}
                className={cn(
                  "flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer",
                  role === "ADMIN"
                    ? "border-amber-500 bg-amber-50/50 text-amber-700 font-semibold shadow-xs"
                    : "border-line text-ink-dim hover:bg-stone-50"
                )}
              >
                <Shield className="h-5 w-5 mb-1 text-amber-600" />
                <span className="text-xs">Admin</span>
                <span className="micro text-ink-faint">Full Access</span>
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Full Name</label>
            <div className="relative">
              <User className="absolute left-3 top-2.5 h-4 w-4 text-ink-dim" />
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Tanmay Kala"
                className="w-full pl-9 pr-3 py-2 text-sm border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-600 bg-canvas"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Work Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-ink-dim" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tanmay@northgate-dist.com"
                className="w-full pl-9 pr-3 py-2 text-sm border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-600 bg-canvas"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 h-4 w-4 text-ink-dim" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full pl-9 pr-3 py-2 text-sm border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-600 bg-canvas"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-ink text-white font-medium text-sm rounded-lg hover:bg-ink/90 transition-colors disabled:opacity-50 cursor-pointer mt-2"
          >
            {loading ? (
              <span>Creating Account...</span>
            ) : (
              <>
                <UserPlus className="h-4 w-4" />
                <span>Register Account</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-4 border-t border-line text-center text-xs text-ink-dim">
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-amber-700 hover:underline inline-flex items-center gap-0.5">
            <ArrowLeft className="h-3 w-3" /> Back to Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
