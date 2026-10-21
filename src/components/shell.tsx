"use client";

import { clsx } from "clsx";
import {
  Activity, BarChart3, Briefcase, Building2, Database, HeartHandshake, LayoutDashboard, Megaphone, Menu, Moon,
  Settings, ShieldCheck, Sun, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { RefreshButton } from "@/components/refresh-button";

export type NavItem = { href: string; label: string; icon: keyof typeof ICONS; group: string };

const ICONS = {
  executive: LayoutDashboard,
  ae: Briefcase,
  activity: Activity,
  marketing: Megaphone,
  product: BarChart3,
  cs: HeartHandshake,
  firms: Building2,
  quality: ShieldCheck,
  health: Database,
  settings: Settings,
};

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <nav className="space-y-4">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{g}</div>
          <div className="space-y-0.5">
            {items.filter((i) => i.group === g).map((n) => {
              const Icon = ICONS[n.icon];
              const active = n.href === "/" ? pathname === "/" : pathname === n.href || pathname.startsWith(n.href + "/");
              return (
                <Link key={n.href} href={n.href} onClick={onNavigate}
                  className={clsx(
                    "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium transition",
                    active
                      ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50",
                  )}>
                  <Icon className={clsx("h-4 w-4 shrink-0", active ? "opacity-100" : "opacity-70")} />
                  {n.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** No React state: the `.dark` class on <html> is the single source of truth
 * (set pre-paint by the inline script in layout.tsx), and the icon swaps via
 * the `dark:` variant, so there is nothing to hydrate. */
function ThemeToggle() {
  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };
  return (
    <button type="button" onClick={toggle} title="Toggle light / dark"
      className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
      <Moon className="h-4 w-4 dark:hidden" />
      <Sun className="hidden h-4 w-4 dark:block" />
    </button>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-xs font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">SW</span>
      <span className="text-sm font-semibold tracking-tight">Silent Witness <span className="text-zinc-400">GTM</span></span>
    </Link>
  );
}

export function Shell({ items, user, children }: {
  items: NavItem[];
  user: { name: string; role: string };
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const footer = (
    <div className="border-t border-zinc-100 px-2 pt-3 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{user.name}</div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-400">{user.role}</div>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-200 bg-white px-3 py-4 dark:border-zinc-800 dark:bg-zinc-900 md:flex">
        <Brand />
        <div className="my-4 px-1"><RefreshButton /></div>
        <div className="min-h-0 flex-1 overflow-y-auto"><NavLinks items={items} /></div>
        {footer}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90 md:hidden">
          <Brand />
          <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-md p-1.5 text-zinc-600 dark:text-zinc-300" aria-label="Menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </header>
        {open ? (
          <div className="border-b border-zinc-200 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900 md:hidden">
            <div className="mb-3 px-1"><RefreshButton /></div>
            <NavLinks items={items} onNavigate={() => setOpen(false)} />
            <div className="mt-3">{footer}</div>
          </div>
        ) : null}
        <main className="min-w-0 flex-1 p-4 md:p-6 lg:p-8">
          <div className="mx-auto max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
