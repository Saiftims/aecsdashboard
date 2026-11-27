-- Every customer case is written to HubSpot as a timeline note on the firm
-- (and the submitting contact where known) so the CS team sees case
-- submissions on the CRM record (owner, 2026-11-27: "can we add the cases
-- being submitted from customers to hubspot?"). The note id is kept here so
-- each case is written exactly once and the note can be found or removed.
alter table cases add column if not exists hubspot_note_id text;
alter table cases add column if not exists hubspot_note_at timestamptz;
create index if not exists cases_hubspot_note_pending
  on cases (submitted_date) where hubspot_note_id is null and company_hubspot_id is not null;
