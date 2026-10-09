-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "sessionId" UUID;

-- CreateIndex
CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");
