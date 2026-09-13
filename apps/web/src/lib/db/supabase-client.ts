/**
 * apps/web/src/lib/db/supabase-client.ts
 * Supabase Client Initializer for Sentinel Ops.
 *
 * Uses NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * Provides a helper `hasSupabaseConfig()` so repositories can gracefully fall back
 * to local memory store when running without database environment variables.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

export function hasSupabaseConfig(): boolean {
  return Boolean(supabaseUrl && supabaseKey);
}

let supabaseInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!hasSupabaseConfig()) {
    return null;
  }
  if (!supabaseInstance) {
    try {
      supabaseInstance = createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false,
        },
      });
    } catch (err) {
      console.warn("Could not initialize Supabase client:", err);
      return null;
    }
  }
  return supabaseInstance;
}
