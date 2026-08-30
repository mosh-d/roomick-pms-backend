-- `feature_flags` has existed since P0 with zero rows and zero code
-- referencing it anywhere — this seeds exactly one real, honest example
-- (the schema's own comment already names "loyalty_module" as a sample),
-- tied to the still-unbuilt Loyalty & Marketing section of this same
-- Management/Admin sequence. Defaults to off for everyone: toggling it on
-- for a tenant is real (persists, resolves correctly) but currently gates
-- nothing, since no business logic reads any flag yet — same stated
-- limitation as the Permission Matrix's own stored-but-unenforced
-- permissions.
INSERT INTO "feature_flags" ("name", "enabledGlobally", "enabledForTenants", "rolloutPct", "updatedAt")
VALUES ('loyalty_module', false, ARRAY[]::UUID[], NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
