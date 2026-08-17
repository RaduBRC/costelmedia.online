-- Adds tenant-editable business-card info (public contact phone + address)
-- surfaced on /admin/settings. Deliberately separate from
-- twilio_phone_number: that column is the AI's inbound routing number
-- (infrastructure), this is the human-facing number a client sees printed
-- on the business's own listing/website and might read back on a call —
-- the two can legitimately differ and neither should silently drive the
-- other.
alter table public.tenants
  add column if not exists public_phone_number text,
  add column if not exists address text;

comment on column public.tenants.public_phone_number is
  'Human-facing contact number for this business (distinct from twilio_phone_number, the AI inbound routing number). Editable via /admin/settings.';
comment on column public.tenants.address is
  'Business street address, free text. Editable via /admin/settings.';
