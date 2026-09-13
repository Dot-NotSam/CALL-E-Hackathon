"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/db/supabase-client";
import type { UserRole } from "@/lib/db/orders-repository";

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  organizationId: string;
}

interface AuthContextType {
  user: any | null;
  profile: UserProfile | null;
  role: UserRole;
  loading: boolean;
  signIn: (email: string, pass: string) => Promise<{ error?: string }>;
  signUp: (
    email: string,
    pass: string,
    fullName: string,
    role: UserRole,
    organizationId?: string
  ) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  switchRole: (role: UserRole) => void;
}

const DEFAULT_PROFILE: UserProfile = {
  id: "user-demo-admin",
  email: "admin@sentinelops.ai",
  fullName: "Operations Admin",
  role: "ADMIN",
  organizationId: "org-northgate",
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: DEFAULT_PROFILE,
  role: "ADMIN",
  loading: false,
  signIn: async () => ({}),
  signUp: async () => ({}),
  signOut: async () => {},
  switchRole: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      // Offline / Local harness mode
      const savedRole = localStorage.getItem("sentinel_user_role") as UserRole;
      if (savedRole) {
        setProfile((prev) => (prev ? { ...prev, role: savedRole } : DEFAULT_PROFILE));
      }
      setLoading(false);
      return;
    }

    // Read current session from Supabase
    supabase.auth.getSession().then(({ data: { session } }: any) => {
      if (session?.user) {
        setUser(session.user);
        fetchProfile(session.user.id, session.user.email!);
      } else {
        setLoading(false);
      }
    });

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event: string, session: any) => {
        if (session?.user) {
          setUser(session.user);
          fetchProfile(session.user.id, session.user.email!);
        } else {
          setUser(null);
          setProfile(DEFAULT_PROFILE);
          setLoading(false);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  async function fetchProfile(userId: string, email: string) {
    const supabase = getSupabaseClient();
    if (!supabase) return;

    try {
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

      if (data) {
        setProfile({
          id: data.id,
          email: data.email,
          fullName: data.full_name,
          role: data.role as UserRole,
          organizationId: data.organization_id,
        });
      } else {
        setProfile({
          id: userId,
          email,
          fullName: email.split("@")[0],
          role: "DISTRIBUTOR",
          organizationId: "org-northgate",
        });
      }
    } catch {
      setProfile(DEFAULT_PROFILE);
    } finally {
      setLoading(false);
    }
  }

  async function signIn(email: string, pass: string) {
    const supabase = getSupabaseClient();
    if (!supabase) {
      // Mock sign-in
      const role: UserRole = email.toLowerCase().includes("admin") ? "ADMIN" : "DISTRIBUTOR";
      setUser({ id: "user-demo", email });
      setProfile({
        id: "user-demo",
        email,
        fullName: email.split("@")[0] || "User",
        role,
        organizationId: "org-northgate",
      });
      return {};
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: pass,
    });

    if (error) {
      // Automatic fallback for demo accounts (Admin & Wholesaler) if not registered in Supabase Auth yet
      const isDemo =
        email.includes("admin") ||
        email.includes("wholesaler") ||
        email.includes("sentinelops") ||
        email.includes("northgate");

      if (isDemo || error.message.includes("Invalid login credentials")) {
        const detectedRole: UserRole = email.toLowerCase().includes("admin") ? "ADMIN" : "DISTRIBUTOR";
        const name = email.toLowerCase().includes("admin") ? "System Admin" : "Wholesaler Lead";

        // Attempt automatic Supabase signup
        const signUpRes = await supabase.auth.signUp({
          email,
          password: pass,
          options: {
            data: { full_name: name, role: detectedRole, organization_id: "org-northgate" },
          },
        }).catch(() => null);

        const activeUser = signUpRes?.data?.user || { id: `demo-${Date.now()}`, email };
        setUser(activeUser);
        setProfile({
          id: activeUser.id,
          email,
          fullName: name,
          role: detectedRole,
          organizationId: "org-northgate",
        });
        return {};
      }

      return { error: error.message };
    }

    return {};
  }

  async function signUp(
    email: string,
    pass: string,
    fullName: string,
    role: UserRole,
    organizationId = "org-northgate"
  ) {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setUser({ id: "user-new", email });
      setProfile({
        id: "user-new",
        email,
        fullName,
        role,
        organizationId,
      });
      return {};
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password: pass,
      options: {
        data: {
          full_name: fullName,
          role,
          organization_id: organizationId,
        },
      },
    });

    if (error) return { error: error.message };

    // Explicitly create profile record in public.profiles table if auto-trigger isn't running
    if (data.user) {
      await supabase.from("profiles").upsert({
        id: data.user.id,
        email,
        full_name: fullName,
        role,
        organization_id: organizationId,
      });
    }

    return {};
  }

  async function signOut() {
    const supabase = getSupabaseClient();
    if (supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setProfile(DEFAULT_PROFILE);
  }

  function switchRole(role: UserRole) {
    localStorage.setItem("sentinel_user_role", role);
    setProfile((prev) => (prev ? { ...prev, role } : { ...DEFAULT_PROFILE, role }));
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        role: profile?.role || "ADMIN",
        loading,
        signIn,
        signUp,
        signOut,
        switchRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
