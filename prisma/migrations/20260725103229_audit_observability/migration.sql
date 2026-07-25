-- AlterTable
ALTER TABLE "AuditedSession" ADD COLUMN "droppedProposalCount" INTEGER;
ALTER TABLE "AuditedSession" ADD COLUMN "notesCreated" INTEGER;
ALTER TABLE "AuditedSession" ADD COLUMN "proposalsCreated" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditRunCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditRunId" TEXT,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheCreationTokens" INTEGER NOT NULL,
    "rawResponse" TEXT,
    "errorText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditRunCall_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "AuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AuditRunCall" ("auditRunId", "cacheCreationTokens", "cacheReadTokens", "createdAt", "id", "inputTokens", "model", "outputTokens", "purpose") SELECT "auditRunId", "cacheCreationTokens", "cacheReadTokens", "createdAt", "id", "inputTokens", "model", "outputTokens", "purpose" FROM "AuditRunCall";
DROP TABLE "AuditRunCall";
ALTER TABLE "new_AuditRunCall" RENAME TO "AuditRunCall";
CREATE INDEX "AuditRunCall_auditRunId_idx" ON "AuditRunCall"("auditRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
