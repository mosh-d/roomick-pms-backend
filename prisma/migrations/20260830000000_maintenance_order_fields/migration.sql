-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "serviceIntervalDays" INTEGER;

-- AlterTable
ALTER TABLE "maintenance_orders" ADD COLUMN     "completionNotes" TEXT,
ADD COLUMN     "partsUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
