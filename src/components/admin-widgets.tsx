"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, inputCls } from "@/components/ui";

export function SettingField({
  settingKey, label, defaultValue, type = "number",
}: {
  settingKey: string;
  label: string;
  defaultValue: string | number;
  type?: "number" | "text";
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(defaultValue));
  const [state, setState] = useState<"idle" | "busy" | "ok" | "err">("idle");

  async function save() {
    setState("busy");
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: settingKey,
        value: type === "number" ? Number(value) : value,
      }),
    });
    setState(res.ok ? "ok" : "err");
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex items-end gap-2">
      <label className="flex-1">
        <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
        <input
          className={inputCls} type={type} value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <Button variant="secondary" onClick={save} disabled={state === "busy"}>
        {state === "busy" ? "..." : state === "ok" ? "Saved" : "Save"}
      </Button>
    </div>
  );
}

export function SyncButton({ full }: { full?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle");
  return (
    <Button
      variant={full ? "secondary" : "primary"}
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full: Boolean(full) }),
        });
        setState(res.ok ? "done" : "err");
        router.refresh();
      }}
    >
      {state === "busy" ? "Syncing..." : state === "done" ? "Synced"
        : state === "err" ? "Failed - retry" : full ? "Full sync" : "Sync now"}
    </Button>
  );
}

export function MappingEditor({
  hubspotCompanyId, companyName, current, swOptions,
}: {
  hubspotCompanyId: string;
  companyName: string;
  current?: { swAccountId: string; swOrganizationId: string | null; perCasePrice: number | null };
  swOptions: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [swId, setSwId] = useState(current?.swOrganizationId ?? current?.swAccountId ?? "");
  const [price, setPrice] = useState(current?.perCasePrice ? String(current.perCasePrice) : "");
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <span className="w-56 truncate text-sm font-medium">{companyName}</span>
      <input
        list={`sw-options-${hubspotCompanyId}`}
        className={`${inputCls} flex-1`}
        placeholder="SW account / organization id"
        value={swId}
        onChange={(e) => setSwId(e.target.value)}
      />
      <datalist id={`sw-options-${hubspotCompanyId}`}>
        {swOptions.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </datalist>
      <input
        className={`${inputCls} w-28`}
        placeholder="$/case"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <Button
        variant="secondary"
        disabled={busy || !swId}
        onClick={async () => {
          setBusy(true);
          await fetch("/api/mapping", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              swAccountId: swId,
              swOrganizationId: swId.startsWith("org_") ? swId : null,
              hubspotCompanyId,
              perCasePrice: price ? Number(price) : null,
              confirmed: true,
            }),
          });
          setBusy(false);
          router.refresh();
        }}
      >
        {busy ? "..." : current ? "Update" : "Map"}
      </Button>
    </div>
  );
}
