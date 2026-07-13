-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "brand_mode_enum" AS ENUM ('single', 'multi');

-- CreateEnum
CREATE TYPE "tenant_status_enum" AS ENUM ('trial', 'active', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "occupancy_status_enum" AS ENUM ('vacant', 'occupied');

-- CreateEnum
CREATE TYPE "cleanliness_status_enum" AS ENUM ('dirty', 'cleaning', 'clean', 'inspected');

-- CreateEnum
CREATE TYPE "held_status_enum" AS ENUM ('out_of_order', 'blocked');

-- CreateEnum
CREATE TYPE "block_reason_enum" AS ENUM ('maintenance', 'renovation', 'vip_hold', 'other');

-- CreateEnum
CREATE TYPE "reservation_status_enum" AS ENUM ('waitlisted', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'walked');

-- CreateEnum
CREATE TYPE "reservation_channel_enum" AS ENUM ('direct', 'walk_in', 'booking_com', 'expedia', 'agoda', 'airbnb');

-- CreateEnum
CREATE TYPE "rate_type_enum" AS ENUM ('base', 'seasonal', 'weekend', 'corporate', 'negotiated', 'promotional');

-- CreateEnum
CREATE TYPE "adjustment_type_enum" AS ENUM ('fixed', 'percentage');

-- CreateEnum
CREATE TYPE "folio_status_enum" AS ENUM ('pending', 'open', 'settled', 'disputed');

-- CreateEnum
CREATE TYPE "charge_type_enum" AS ENUM ('room', 'fnb', 'spa', 'laundry', 'minibar', 'transport', 'tax', 'penalty', 'correction', 'misc');

-- CreateEnum
CREATE TYPE "payment_method_enum" AS ENUM ('cash', 'card', 'bank_transfer', 'voucher', 'loyalty_points');

-- CreateEnum
CREATE TYPE "payment_purpose_enum" AS ENUM ('payment', 'deposit', 'deposit_application');

-- CreateEnum
CREATE TYPE "refund_status_enum" AS ENUM ('pending', 'approved', 'rejected', 'processed');

-- CreateEnum
CREATE TYPE "penalty_type_enum" AS ENUM ('first_night', 'full_stay', 'flat_fee', 'none');

-- CreateEnum
CREATE TYPE "outlet_category_enum" AS ENUM ('restaurant', 'bar', 'spa', 'laundry', 'retail', 'room_service');

-- CreateEnum
CREATE TYPE "hk_status_enum" AS ENUM ('pending', 'in_progress', 'done', 'skipped');

-- CreateEnum
CREATE TYPE "shift_type_enum" AS ENUM ('morning', 'evening', 'night');

-- CreateEnum
CREATE TYPE "issue_priority_enum" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "issue_status_enum" AS ENUM ('open', 'resolved', 'carried_over');

-- CreateEnum
CREATE TYPE "maintenance_priority_enum" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "maintenance_status_enum" AS ENUM ('open', 'in_progress', 'on_hold', 'resolved', 'cancelled');

-- CreateEnum
CREATE TYPE "night_audit_status_enum" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "comms_channel_enum" AS ENUM ('email', 'sms', 'push', 'in_app_chat');

-- CreateEnum
CREATE TYPE "delivery_status_enum" AS ENUM ('queued', 'sent', 'delivered', 'failed', 'opened', 'bounced');

-- CreateEnum
CREATE TYPE "gdpr_type_enum" AS ENUM ('access', 'erasure', 'portability');

-- CreateEnum
CREATE TYPE "gdpr_status_enum" AS ENUM ('pending', 'in_progress', 'completed', 'rejected');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subdomain" VARCHAR(63) NOT NULL,
    "groupName" VARCHAR(200) NOT NULL,
    "brandMode" "brand_mode_enum" NOT NULL,
    "status" "tenant_status_enum" NOT NULL DEFAULT 'trial',
    "trialEndsAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(72),
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_branch_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "branchId" UUID,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" UUID,

    CONSTRAINT "user_branch_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "roleId" UUID NOT NULL,
    "branchId" UUID,
    "invitedBy" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" VARCHAR(7),
    "defaultPolicies" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address" JSONB NOT NULL,
    "timezone" VARCHAR(50) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "checkInTime" TIME(0) NOT NULL DEFAULT '14:00:00'::time,
    "checkOutTime" TIME(0) NOT NULL DEFAULT '11:00:00'::time,
    "category" VARCHAR(30),
    "policies" JSONB,
    "noShowPolicy" JSONB,
    "regCardTemplate" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "floorNumber" INTEGER NOT NULL,
    "label" VARCHAR(30),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "baseRate" DECIMAL(12,2) NOT NULL,
    "capacity" JSONB NOT NULL,
    "bedType" VARCHAR(50),
    "sizeM2" DECIMAL(6,1),
    "amenities" TEXT[],
    "photoUrls" TEXT[],
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "floorId" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "occupancyStatus" "occupancy_status_enum" NOT NULL DEFAULT 'vacant',
    "cleanlinessStatus" "cleanliness_status_enum" NOT NULL DEFAULT 'clean',
    "heldStatus" "held_status_enum",
    "view" VARCHAR(50),
    "notes" TEXT,
    "statusChangedAt" TIMESTAMPTZ(6),
    "statusChangedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "reason" "block_reason_enum" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "notes" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(20),
    "nationality" CHAR(2),
    "idDocType" VARCHAR(30),
    "idDocNumber" TEXT,
    "idDocUrl" TEXT,
    "idDocExpiryDate" DATE,
    "preferences" JSONB,
    "vipLevel" SMALLINT DEFAULT 0,
    "tags" TEXT[],
    "notes" TEXT,
    "loyaltyTier" VARCHAR(30),
    "loyaltyPoints" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "guest_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "confirmationNumber" VARCHAR(20) NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "roomId" UUID,
    "ratePlanId" UUID,
    "confirmedRate" DECIMAL(12,2) NOT NULL,
    "overrideRate" DECIMAL(12,2),
    "overrideReason" TEXT,
    "status" "reservation_status_enum" NOT NULL DEFAULT 'confirmed',
    "channel" "reservation_channel_enum" NOT NULL,
    "checkInDate" DATE NOT NULL,
    "checkOutDate" DATE NOT NULL,
    "actualCheckIn" TIMESTAMPTZ(6),
    "actualCheckOut" TIMESTAMPTZ(6),
    "adults" SMALLINT NOT NULL,
    "children" SMALLINT NOT NULL DEFAULT 0,
    "specialRequests" TEXT,
    "depositAmount" DECIMAL(12,2),
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomTypeId" UUID,
    "name" VARCHAR(150) NOT NULL,
    "type" "rate_type_enum" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "adjustmentType" "adjustment_type_enum",
    "cascadeTier" SMALLINT NOT NULL,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" DATE,
    "validTo" DATE,
    "minLOS" SMALLINT,
    "promoCode" VARCHAR(30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "outletId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "reservationId" UUID,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "triggeredBy" VARCHAR(30),
    "userId" UUID,
    "resolvedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "no_show_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "penaltyType" "penalty_type_enum" NOT NULL,
    "penaltyAmount" DECIMAL(12,2),
    "penaltyWaived" BOOLEAN NOT NULL DEFAULT false,
    "waivedBy" UUID,
    "refundAmount" DECIMAL(12,2),
    "markedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedBy" UUID,

    CONSTRAINT "no_show_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "walk_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "relocationProperty" VARCHAR(200) NOT NULL,
    "transportProvided" BOOLEAN NOT NULL DEFAULT false,
    "transportCost" DECIMAL(12,2),
    "compensationOffered" TEXT,
    "approvedBy" UUID,
    "walkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "walk_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "emailDomains" TEXT[],
    "ratePlanId" UUID,
    "contactName" VARCHAR(200),
    "contactEmail" VARCHAR(320),
    "billingInfo" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "label" VARCHAR(100),
    "status" "folio_status_enum" NOT NULL DEFAULT 'pending',
    "payerName" VARCHAR(200),
    "payerEmail" VARCHAR(320),
    "corporateAccountId" UUID,
    "openedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "chargeType" "charge_type_enum" NOT NULL,
    "outletId" UUID,
    "taxRuleIds" UUID[],
    "serviceDate" DATE,
    "postedBy" UUID,
    "postedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "sourceFolioId" UUID NOT NULL,
    "targetFolioId" UUID NOT NULL,
    "lineItemIds" UUID[],
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedBy" UUID,
    "reversedAt" TIMESTAMPTZ(6),
    "reversedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folio_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "method" "payment_method_enum" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reference" VARCHAR(100),
    "shiftId" UUID,
    "paymentPurpose" "payment_purpose_enum" NOT NULL DEFAULT 'payment',
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedBy" UUID,
    "voidReason" TEXT,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "paymentId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "refund_status_enum" NOT NULL DEFAULT 'pending',
    "requestedBy" UUID,
    "approvedBy" UUID,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "rate" DECIMAL(6,4) NOT NULL,
    "type" "adjustment_type_enum" NOT NULL DEFAULT 'percentage',
    "appliesToChargeTypes" "charge_type_enum"[],
    "jurisdiction" VARCHAR(100),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "assigneeId" UUID,
    "taskDate" DATE NOT NULL,
    "status" "hk_status_enum" NOT NULL DEFAULT 'pending',
    "priority" SMALLINT,
    "triggerEvent" VARCHAR(30),
    "triggeredByReservationId" UUID,
    "notes" TEXT,
    "completedAt" TIMESTAMPTZ(6),
    "completedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "housekeeping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "shiftType" "shift_type_enum" NOT NULL,
    "activeOutletId" UUID,
    "openedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(6),
    "openingFloat" DECIMAL(12,2),
    "openingBreakdown" JSONB,
    "systemCashTotal" DECIMAL(12,2),
    "closingCashCounted" DECIMAL(12,2),
    "closingBreakdown" JSONB,
    "variance" DECIMAL(12,2),
    "varianceExplanation" TEXT,
    "handoverNotes" TEXT,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "issue_priority_enum" NOT NULL DEFAULT 'medium',
    "status" "issue_status_enum" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "shift_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomId" UUID,
    "assetId" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "priority" "maintenance_priority_enum" NOT NULL DEFAULT 'medium',
    "status" "maintenance_status_enum" NOT NULL DEFAULT 'open',
    "takesRoomOutOfService" BOOLEAN NOT NULL DEFAULT false,
    "reportedBy" UUID,
    "assignedTo" UUID,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomId" UUID,
    "name" VARCHAR(200) NOT NULL,
    "category" VARCHAR(100),
    "serialNumber" VARCHAR(100),
    "purchaseDate" DATE,
    "warrantyUntil" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "fields" JSONB NOT NULL,
    "signatureData" TEXT,
    "signedAt" TIMESTAMPTZ(6),
    "witnessedBy" UUID,
    "documentUrl" TEXT,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" DATE,

    CONSTRAINT "registration_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overbooking_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomTypeId" UUID,
    "globalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxOverbookPct" DECIMAL(5,2),
    "alertAtPct" DECIMAL(5,2),
    "validFrom" DATE,
    "validTo" DATE,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "overbooking_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" "outlet_category_enum" NOT NULL,
    "chargeType" "charge_type_enum" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_outlets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "assignedBy" UUID,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "auditDate" DATE NOT NULL,
    "triggeredBy" UUID,
    "triggeredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "night_audit_status_enum" NOT NULL DEFAULT 'running',
    "foliosProcessed" INTEGER,
    "chargesPosted" INTEGER,
    "totalAmountPosted" DECIMAL(14,2),
    "errors" JSONB,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "night_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "reservationId" UUID,
    "guestId" UUID NOT NULL,
    "channel" "comms_channel_enum" NOT NULL,
    "subject" VARCHAR(500),
    "body" TEXT NOT NULL,
    "trigger" VARCHAR(50) NOT NULL,
    "deliveryStatus" "delivery_status_enum" NOT NULL DEFAULT 'queued',
    "externalMessageId" VARCHAR(200),
    "sentBy" UUID,
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(6),

    CONSTRAINT "communication_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "userId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(50),
    "entityId" UUID,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" INET,
    "userAgent" TEXT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gdpr_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "type" "gdpr_type_enum" NOT NULL,
    "status" "gdpr_status_enum" NOT NULL DEFAULT 'pending',
    "requestedBy" VARCHAR(320) NOT NULL,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" DATE NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "exportUrl" TEXT,
    "notes" TEXT,

    CONSTRAINT "gdpr_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "enabledGlobally" BOOLEAN NOT NULL DEFAULT false,
    "enabledForTenants" UUID[],
    "rolloutPct" SMALLINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" VARCHAR(200),

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "type" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "storageUrl" TEXT,
    "sizeBytes" BIGINT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "retainUntil" DATE,

    CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain");

-- CreateIndex
CREATE INDEX "users_tenantId_deletedAt_idx" ON "users"("tenantId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_name_key" ON "roles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "user_branch_roles_userId_branchId_idx" ON "user_branch_roles"("userId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "user_branch_roles_userId_roleId_branchId_key" ON "user_branch_roles"("userId", "roleId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "invite_tokens_token_key" ON "invite_tokens"("token");

-- CreateIndex
CREATE INDEX "invite_tokens_tenantId_email_idx" ON "invite_tokens"("tenantId", "email");

-- CreateIndex
CREATE INDEX "brands_tenantId_deletedAt_idx" ON "brands"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "branches_tenantId_brandId_idx" ON "branches"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "branches_tenantId_deletedAt_idx" ON "branches"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "buildings_branchId_idx" ON "buildings"("branchId");

-- CreateIndex
CREATE INDEX "floors_buildingId_idx" ON "floors"("buildingId");

-- CreateIndex
CREATE INDEX "room_types_branchId_deletedAt_idx" ON "room_types"("branchId", "deletedAt");

-- CreateIndex
CREATE INDEX "rooms_branchId_occupancyStatus_cleanlinessStatus_idx" ON "rooms"("branchId", "occupancyStatus", "cleanlinessStatus");

-- CreateIndex
CREATE INDEX "rooms_branchId_roomTypeId_occupancyStatus_idx" ON "rooms"("branchId", "roomTypeId", "occupancyStatus");

-- CreateIndex
CREATE INDEX "rooms_branchId_cleanlinessStatus_idx" ON "rooms"("branchId", "cleanlinessStatus");

-- CreateIndex
CREATE INDEX "rooms_floorId_cleanlinessStatus_idx" ON "rooms"("floorId", "cleanlinessStatus");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_branchId_number_key" ON "rooms"("branchId", "number");

-- CreateIndex
CREATE INDEX "room_blocks_roomId_fromDate_toDate_idx" ON "room_blocks"("roomId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "guest_profiles_tenantId_email_idx" ON "guest_profiles"("tenantId", "email");

-- CreateIndex
CREATE INDEX "guest_profiles_tenantId_name_idx" ON "guest_profiles"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_confirmationNumber_key" ON "reservations"("confirmationNumber");

-- CreateIndex
CREATE INDEX "reservations_branchId_checkInDate_status_idx" ON "reservations"("branchId", "checkInDate", "status");

-- CreateIndex
CREATE INDEX "reservations_branchId_checkOutDate_status_idx" ON "reservations"("branchId", "checkOutDate", "status");

-- CreateIndex
CREATE INDEX "reservations_roomId_checkInDate_checkOutDate_idx" ON "reservations"("roomId", "checkInDate", "checkOutDate");

-- CreateIndex
CREATE INDEX "reservations_guestId_idx" ON "reservations"("guestId");

-- CreateIndex
CREATE INDEX "reservations_branchId_status_checkInDate_idx" ON "reservations"("branchId", "status", "checkInDate");

-- CreateIndex
CREATE INDEX "rate_plans_branchId_roomTypeId_isOverride_cascadeTier_idx" ON "rate_plans"("branchId", "roomTypeId", "isOverride", "cascadeTier");

-- CreateIndex
CREATE INDEX "rate_plans_branchId_validFrom_validTo_idx" ON "rate_plans"("branchId", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "rate_plans_branchId_isOverride_idx" ON "rate_plans"("branchId", "isOverride");

-- CreateIndex
CREATE INDEX "rate_audit_log_reservationId_idx" ON "rate_audit_log"("reservationId");

-- CreateIndex
CREATE INDEX "no_show_records_reservationId_idx" ON "no_show_records"("reservationId");

-- CreateIndex
CREATE INDEX "walk_records_reservationId_idx" ON "walk_records"("reservationId");

-- CreateIndex
CREATE INDEX "corporate_accounts_tenantId_isActive_idx" ON "corporate_accounts"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "folios_reservationId_idx" ON "folios"("reservationId");

-- CreateIndex
CREATE INDEX "folios_branchId_status_idx" ON "folios"("branchId", "status");

-- CreateIndex
CREATE INDEX "line_items_folioId_postedAt_idx" ON "line_items"("folioId", "postedAt");

-- CreateIndex
CREATE INDEX "line_items_folioId_chargeType_idx" ON "line_items"("folioId", "chargeType");

-- CreateIndex
CREATE INDEX "line_items_outletId_idx" ON "line_items"("outletId");

-- CreateIndex
CREATE INDEX "folio_transfers_sourceFolioId_idx" ON "folio_transfers"("sourceFolioId");

-- CreateIndex
CREATE INDEX "folio_transfers_targetFolioId_idx" ON "folio_transfers"("targetFolioId");

-- CreateIndex
CREATE INDEX "payments_folioId_paymentPurpose_idx" ON "payments"("folioId", "paymentPurpose");

-- CreateIndex
CREATE INDEX "payments_shiftId_idx" ON "payments"("shiftId");

-- CreateIndex
CREATE INDEX "refunds_folioId_idx" ON "refunds"("folioId");

-- CreateIndex
CREATE INDEX "tax_rules_branchId_isActive_idx" ON "tax_rules"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_branchId_taskDate_status_idx" ON "housekeeping_tasks"("branchId", "taskDate", "status");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_assigneeId_taskDate_status_idx" ON "housekeeping_tasks"("assigneeId", "taskDate", "status");

-- CreateIndex
CREATE INDEX "shifts_branchId_closedAt_idx" ON "shifts"("branchId", "closedAt");

-- CreateIndex
CREATE INDEX "shifts_branchId_openedAt_idx" ON "shifts"("branchId", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "shift_issues_shiftId_status_idx" ON "shift_issues"("shiftId", "status");

-- CreateIndex
CREATE INDEX "maintenance_orders_branchId_status_idx" ON "maintenance_orders"("branchId", "status");

-- CreateIndex
CREATE INDEX "assets_branchId_idx" ON "assets"("branchId");

-- CreateIndex
CREATE INDEX "registration_cards_reservationId_idx" ON "registration_cards"("reservationId");

-- CreateIndex
CREATE INDEX "registration_cards_guestId_generatedAt_idx" ON "registration_cards"("guestId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "registration_cards_branchId_retainUntil_idx" ON "registration_cards"("branchId", "retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "overbooking_config_branchId_roomTypeId_key" ON "overbooking_config"("branchId", "roomTypeId");

-- CreateIndex
CREATE INDEX "outlets_branchId_isActive_idx" ON "outlets"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "outlets_branchId_category_idx" ON "outlets"("branchId", "category");

-- CreateIndex
CREATE INDEX "user_outlets_userId_branchId_idx" ON "user_outlets"("userId", "branchId");

-- CreateIndex
CREATE INDEX "user_outlets_outletId_idx" ON "user_outlets"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "user_outlets_userId_outletId_key" ON "user_outlets"("userId", "outletId");

-- CreateIndex
CREATE INDEX "night_audit_log_branchId_auditDate_idx" ON "night_audit_log"("branchId", "auditDate" DESC);

-- CreateIndex
CREATE INDEX "night_audit_log_status_idx" ON "night_audit_log"("status");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_log_branchId_auditDate_key" ON "night_audit_log"("branchId", "auditDate");

-- CreateIndex
CREATE INDEX "communication_log_reservationId_sentAt_idx" ON "communication_log"("reservationId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "communication_log_guestId_sentAt_idx" ON "communication_log"("guestId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "communication_log_branchId_deliveryStatus_sentAt_idx" ON "communication_log"("branchId", "deliveryStatus", "sentAt");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_timestamp_idx" ON "audit_log"("tenantId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_idx" ON "audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_userId_timestamp_idx" ON "audit_log"("userId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "gdpr_requests_tenantId_status_idx" ON "gdpr_requests"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_name_key" ON "feature_flags"("name");

-- CreateIndex
CREATE INDEX "backup_records_tenantId_idx" ON "backup_records"("tenantId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_roles" ADD CONSTRAINT "user_branch_roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_roles" ADD CONSTRAINT "user_branch_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_roles" ADD CONSTRAINT "user_branch_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_roles" ADD CONSTRAINT "user_branch_roles_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_roles" ADD CONSTRAINT "user_branch_roles_assignedBy_fkey" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "floors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_statusChangedBy_fkey" FOREIGN KEY ("statusChangedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "rate_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_audit_log" ADD CONSTRAINT "rate_audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_audit_log" ADD CONSTRAINT "rate_audit_log_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_audit_log" ADD CONSTRAINT "rate_audit_log_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_audit_log" ADD CONSTRAINT "rate_audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_records" ADD CONSTRAINT "no_show_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_records" ADD CONSTRAINT "no_show_records_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_records" ADD CONSTRAINT "no_show_records_waivedBy_fkey" FOREIGN KEY ("waivedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_records" ADD CONSTRAINT "no_show_records_markedBy_fkey" FOREIGN KEY ("markedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "walk_records" ADD CONSTRAINT "walk_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "walk_records" ADD CONSTRAINT "walk_records_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "walk_records" ADD CONSTRAINT "walk_records_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "rate_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_postedBy_fkey" FOREIGN KEY ("postedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_voidedBy_fkey" FOREIGN KEY ("voidedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_transfers" ADD CONSTRAINT "folio_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_transfers" ADD CONSTRAINT "folio_transfers_sourceFolioId_fkey" FOREIGN KEY ("sourceFolioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_transfers" ADD CONSTRAINT "folio_transfers_targetFolioId_fkey" FOREIGN KEY ("targetFolioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_transfers" ADD CONSTRAINT "folio_transfers_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_transfers" ADD CONSTRAINT "folio_transfers_reversedBy_fkey" FOREIGN KEY ("reversedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedBy_fkey" FOREIGN KEY ("recordedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_voidedBy_fkey" FOREIGN KEY ("voidedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_completedBy_fkey" FOREIGN KEY ("completedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_triggeredByReservationId_fkey" FOREIGN KEY ("triggeredByReservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_activeOutletId_fkey" FOREIGN KEY ("activeOutletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_issues" ADD CONSTRAINT "shift_issues_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_issues" ADD CONSTRAINT "shift_issues_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_issues" ADD CONSTRAINT "shift_issues_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_reportedBy_fkey" FOREIGN KEY ("reportedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_witnessedBy_fkey" FOREIGN KEY ("witnessedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overbooking_config" ADD CONSTRAINT "overbooking_config_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overbooking_config" ADD CONSTRAINT "overbooking_config_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overbooking_config" ADD CONSTRAINT "overbooking_config_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overbooking_config" ADD CONSTRAINT "overbooking_config_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_assignedBy_fkey" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_log" ADD CONSTRAINT "night_audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_log" ADD CONSTRAINT "night_audit_log_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_log" ADD CONSTRAINT "night_audit_log_triggeredBy_fkey" FOREIGN KEY ("triggeredBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_log" ADD CONSTRAINT "communication_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_log" ADD CONSTRAINT "communication_log_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_log" ADD CONSTRAINT "communication_log_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_log" ADD CONSTRAINT "communication_log_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_log" ADD CONSTRAINT "communication_log_sentBy_fkey" FOREIGN KEY ("sentBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gdpr_requests" ADD CONSTRAINT "gdpr_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gdpr_requests" ADD CONSTRAINT "gdpr_requests_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

