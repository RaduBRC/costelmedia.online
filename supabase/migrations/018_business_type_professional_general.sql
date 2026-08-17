-- 018_business_type_professional_general.sql
-- Adds the two verticals promptBuilder.ts's dynamic-instruction refactor
-- needs that business_type didn't have a value for yet: 'legal_services'
-- (professional services / legal consultations) and 'general_services'
-- (a generic fallback for a business that doesn't fit any named vertical).
-- Same additive pattern as 013_business_type_verticals.sql (auto_shop,
-- salon) — existing rows and every other value are untouched. Kept as its
-- own migration, not combined with the tenant_faqs/tone_of_voice work in
-- 019, because a Postgres enum value added via ALTER TYPE ... ADD VALUE
-- cannot be referenced in the same transaction it was added in.
--
-- See src/agent/promptBuilder.ts for the matching BUSINESS_TYPE_RULES/
-- BUSINESS_TYPE_LABELS/VOICE_GREETING_BY_BUSINESS_TYPE entries and
-- src/types/index.ts for the BusinessType union.
alter type business_type add value if not exists 'legal_services';
alter type business_type add value if not exists 'general_services';
