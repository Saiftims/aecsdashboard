-- When FlyTech qualified a Meta lead (appeared on its sheet, or booked a
-- demo) and the deal was moved to MQL because of it. Null = not qualified yet;
-- checked every run for recent leads whose deal still sits in Unqualified Lead.
alter table meta_leads add column if not exists qualified_at timestamptz;
alter table meta_leads add column if not exists qualified_via text;
