import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Shell, type NavItem } from "@/components/shell";
import { currentAppUser } from "@/lib/supabase/server";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "Silent Witness GTM",
  description: "Sales & Customer Success operating system",
};

// Every signed-in user sees every page (owner, 2026-10-27: "remove all
// permissions, let everyone see everything"). Role only labels the sidebar.
const NAV: NavItem[] = [
  { href: "/", label: "Executive", icon: "executive", group: "Overview" },
  { href: "/activity", label: "Activity & funnel", icon: "activity", group: "Overview" },
  { href: "/ae", label: "Sales (AE)", icon: "ae", group: "Teams" },
  { href: "/cs", label: "Customer success", icon: "cs", group: "Teams" },
  { href: "/marketing", label: "Marketing", icon: "marketing", group: "Teams" },
  { href: "/product", label: "Product", icon: "product", group: "Teams" },
  { href: "/firms", label: "Firms", icon: "firms", group: "Records" },
  { href: "/data-quality", label: "Data quality", icon: "quality", group: "Records" },
  { href: "/health", label: "System health", icon: "health", group: "Admin" },
  { href: "/settings", label: "Settings", icon: "settings", group: "Admin" },
];

/** Applies the saved theme before first paint so dark mode does not flash. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentAppUser().catch(() => null);
  const nav = user ? NAV : [];

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${geist.variable} ${geist.className} min-h-screen bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100`}>
        {user ? (
          <Shell items={nav} user={{ name: user.full_name ?? user.email, role: user.role }}>{children}</Shell>
        ) : (
          <main>{children}</main>
        )}
      </body>
    </html>
  );
}
