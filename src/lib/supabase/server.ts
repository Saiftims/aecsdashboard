import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
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

/** Read a whole table, in pages.
 *
 * PostgREST answers at most 1000 rows per request and says nothing about the
 * rest, so a plain `.select()` on a table that has outgrown that silently
 * returns a slice - and with no ORDER BY, an arbitrary one. That is not a
 * capacity problem you notice: every figure downstream just comes out low. It
 * cost the Activity page roughly a third of a CSM's week once `activities`
 * passed 1000 rows.
 *
 * Throws rather than returning a partial table: wrong numbers presented as
 * right are worse than an error.
 */
export async function selectAll<T>(
  table: string,
  columns = "*",
  orderBy = "hubspot_id",
): Promise<T[]> {
  const sb = supabaseService();
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`selectAll(${table}): ${error.message}`);
    out.push(...((data ?? []) as unknown as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

export interface AppUser {
  id: string;
  email: string;
  full_name: string | null;
  role: "executive" | "ae" | "cs";
  hubspot_owner_id: string | null;
}

/** Current app user (or null when unauthenticated). Wrapped in React cache()
 * so layout + page share ONE lookup per request instead of hitting Supabase
 * auth twice (matters: each round trip is a network hop to Supabase). */
export const currentAppUser = cache(async (): Promise<AppUser | null> => {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from("app_users").select("*").eq("id", user.id).single();
  return (data as AppUser) ?? null;
});
