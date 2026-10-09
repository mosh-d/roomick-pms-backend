-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "turndownPolicy" JSONB;

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "heldUntil" DATE;

-- A release date belongs to a held room only.
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_held_until_needs_hold" CHECK ("heldUntil" IS NULL OR "heldStatus" IS NOT NULL);
