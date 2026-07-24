-- AlterTable
ALTER TABLE "AuditedSession" ADD COLUMN "transcriptTokenTotal" INTEGER;

-- CreateTable
CREATE TABLE "AuditSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "maxSonnetCallsPerRun" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" DATETIME NOT NULL
);
