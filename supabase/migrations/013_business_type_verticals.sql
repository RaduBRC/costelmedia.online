-- 013_business_type_verticals.sql
-- Adds the two verticals the original multi-tenant request named as
-- target customers ("clinics, salons, auto shops") that business_type
-- (001_init.sql) didn't have a value for yet: 'auto_shop' and 'salon'.
-- Needed right now for the Step 5 verification tenant ("Auto Doc
-- Service"); 'salon' added alongside it since it was named in the same
-- breath and this is a one-line addition either way.
--
-- ADD VALUE is additive/non-breaking — existing rows and the 'restaurant'/
-- 'clinic'/'callcenter' values are untouched. See src/agent/promptBuilder.ts
-- for the matching BUSINESS_TYPE_RULES/BUSINESS_TYPE_LABELS entries and
-- src/types/index.ts for the BusinessType union.
alter type business_type add value if not exists 'auto_shop';
alter type business_type add value if not exists 'salon';
