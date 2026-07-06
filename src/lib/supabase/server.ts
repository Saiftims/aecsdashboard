import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/** Auth-aware client for server components / route handlers (RLS enforced). */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (all) => {
        try {
          all.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // called from a Server Component - middleware refreshes sessions
        }
      },
    },
  });
}

/** Service-role client for sync jobs and write-back APIs (bypasses RLS).
 * Server-only - never import in client components. */
let service: SupabaseClient | null = null;
export function supabaseService(): SupabaseClient {
  if (!service) {
    service = createClient(env.supabaseUrl(), env.supabaseServiceKey(), {
      auth: { persistSession: false },
    });
  }
  return service;
}

export interface AppUser {
  id: string;
  email: string;
  full_name: string | null;
  role: "executive" | "ae" | "cs";
  hubspot_owner_id: string | null;
}

/** Current app user (or null when unauthenticated). */
export async function currentAppUser(): Promise<AppUser | null> {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from("app_users").select("*").eq("id", user.id).single();
  return (data as AppUser) ?? null;
}
