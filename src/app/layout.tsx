import type { Metadata } from "next";
import Link from "next/link";
import { Geist } from "next/font/google";
import "./globals.css";
import { RefreshButton } from "@/components/refresh-button";
import { currentAppUser } from "@/lib/supabase/server";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Silent Witness GTM",
  description: "Sales & Customer Success operating system",
};

const NAV = [
  { href: "/", label: "Executive", roles: ["executive"] },
  { href: "/ae", label: "AE", roles: ["executive", "ae"] },
  { href: "/activity", label: "Activity & Funnel", roles: ["executive", "ae", "cs"] },
  { href: "/product", label: "Product", roles: ["executive", "cs"] },
  { href: "/cs", label: "Customer Success", roles: ["executive", "cs"] },
  { href: "/firms", label: "Firms", roles: ["executive", "ae", "cs"] },
  { href: "/data-quality", label: "Data Quality", roles: ["executive", "ae", "cs"] },
  { href: "/settings", label: "Settings", roles: ["executive"] },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentAppUser().catch(() => null);
  const nav = user ? NAV.filter((n) => n.roles.includes(user.role)) : [];

  return (
    <html lang="en">
      <body className={`${geist.className} min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100`}>
        {user ? (
          <div className="flex min-h-screen">
            <aside className="hidden w-56 shrink-0 border-r border-zinc-200 bg-white px-3 py-5 dark:border-zinc-800 dark:bg-zinc-900 md:block">
              <div className="mb-4 px-2 text-lg font-bold">
                Silent Witness <span className="text-zinc-400">GTM</span>
              </div>
              <div className="mb-4 px-1">
                <RefreshButton />
              </div>
              <nav className="space-y-1">
                {nav.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="block rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
              <div className="mt-8 border-t border-zinc-100 px-2 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                {user.full_name ?? user.email}
                <div className="uppercase tracking-wide">{user.role}</div>
              </div>
            </aside>
            <main className="min-w-0 flex-1 p-6">{children}</main>
          </div>
        ) : (
          <main>{children}</main>
        )}
      </body>
    </html>
  );
}
