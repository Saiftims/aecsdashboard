/** The marketing team's Meta lead sheet: tab 1 holds ad-form fills, the
 * "Calendly" tab holds people who booked straight onto the calendar from an ad.
 * It is the only record of which HubSpot deals came from paid social, since
 * `sw_lead_source` is stamped by hand and missing on most older deals. */
const SHEET_ID = process.env.META_LEADS_SHEET_ID ?? "1gR7fl8X5bditzRafuMgDKocEQhHcbPw1Wn63KTHEigo";
const FORM_GID = "0";
const BOOKING_GID = "1980897641";

export type MetaLeadIndex = {
  formEmails: Set<string>;
  formNames: Set<string>;
  bookingEmails: Set<string>;
  bookingNames: Set<string>;
};

export const normName = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function loadTab(gid: string, emailCol: string, nameCol: string) {
  const emails = new Set<string>();
  const names = new Set<string>();
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`, {
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`meta sheet tab ${gid}: HTTP ${res.status}`);
  const [header, ...rows] = parseCsv(await res.text());
  const e = header.indexOf(emailCol);
  const n = header.indexOf(nameCol);
  for (const r of rows) {
    const email = (r[e] ?? "").trim().toLowerCase();
    if (email) emails.add(email);
    const name = normName(r[n]);
    if (name) names.add(name);
  }
  return { emails, names };
}

/** Null when the sheet cannot be read, so the chart falls back to one series
 * instead of reporting every lead as non-Meta. */
export async function loadMetaLeadIndex(): Promise<MetaLeadIndex | null> {
  try {
    const [form, booking] = await Promise.all([
      loadTab(FORM_GID, "Email", "Name"),
      loadTab(BOOKING_GID, "Invitee email", "Invitee name"),
    ]);
    return { formEmails: form.emails, formNames: form.names, bookingEmails: booking.emails, bookingNames: booking.names };
  } catch (err) {
    console.error("loadMetaLeadIndex", err);
    return null;
  }
}

export interface MetaSheetRow {
  tab: "form" | "booking";
  name: string;
  email: string;
  /** ISO timestamp, or null when the row's date cannot be read. */
  at: string | null;
}

/** "Sun Oct 4, 2026 5:26 PM" in Pacific time -> ISO. */
function pacificToIso(s: string): string | null {
  const naive = Date.parse(`${s.replace(/^[A-Za-z]{3,}\s+/, "")} UTC`);
  if (Number.isNaN(naive)) return null;
  const asLa = new Date(new Date(naive).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const asUtc = new Date(new Date(naive).toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(naive + (asUtc.getTime() - asLa.getTime())).toISOString();
}

/** Every dated row on both tabs. The form tab's "Date Created" is UTC (it
 * matches HubSpot's conversion timestamp to the second); the Calendly tab's
 * "Booked at (PT)" is Pacific. Null when the sheet cannot be read. */
export async function loadMetaSheetRows(): Promise<MetaSheetRow[] | null> {
  try {
    const read = async (gid: string) => {
      const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`, {
        next: { revalidate: 300 },
      });
      if (!res.ok) throw new Error(`meta sheet tab ${gid}: HTTP ${res.status}`);
      return parseCsv(await res.text());
    };
    const [[fh, ...form], [bh, ...booking]] = await Promise.all([read(FORM_GID), read(BOOKING_GID)]);
    const col = (h: string[], name: string) => h.indexOf(name);
    const out: MetaSheetRow[] = [];
    for (const r of form) {
      const raw = (r[col(fh, "Date Created")] ?? "").trim();
      const t = raw ? Date.parse(`${raw.replace(" ", "T")}Z`) : NaN;
      out.push({
        tab: "form",
        name: (r[col(fh, "Name")] ?? "").trim(),
        email: (r[col(fh, "Email")] ?? "").trim().toLowerCase(),
        at: Number.isNaN(t) ? null : new Date(t).toISOString(),
      });
    }
    for (const r of booking) {
      if ((r[col(bh, "Status")] ?? "").trim().toLowerCase() === "canceled") continue;
      out.push({
        tab: "booking",
        name: (r[col(bh, "Invitee name")] ?? "").trim(),
        email: (r[col(bh, "Invitee email")] ?? "").trim().toLowerCase(),
        at: pacificToIso((r[col(bh, "Booked at (PT)")] ?? "").trim()),
      });
    }
    return out.filter((r) => r.name || r.email);
  } catch (err) {
    console.error("loadMetaSheetRows", err);
    return null;
  }
}

export type MqlSource = "metaForm" | "metaBooking" | "other";

/** A lead who filled the form and then booked counts as a form fill: the form
 * is where they entered the funnel. */
export function classifyMql(idx: MetaLeadIndex, emails: string[], names: string[]): MqlSource {
  if (emails.some((e) => idx.formEmails.has(e)) || names.some((n) => idx.formNames.has(n))) return "metaForm";
  if (emails.some((e) => idx.bookingEmails.has(e)) || names.some((n) => idx.bookingNames.has(n))) return "metaBooking";
  return "other";
}
