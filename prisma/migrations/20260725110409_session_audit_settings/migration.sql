-- AlterTable
ALTER TABLE "AnalysisNote" ADD COLUMN "ruleRef" TEXT;

-- AlterTable
ALTER TABLE "AuditedSession" ADD COLUMN "transcriptFileMtime" DATETIME;
ALTER TABLE "AuditedSession" ADD COLUMN "transcriptFileSize" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "maxSonnetCallsPerRun" INTEGER NOT NULL DEFAULT 10,
    "judgmentModel" TEXT NOT NULL DEFAULT 'claude-sonnet-5',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AuditSettings" ("id", "maxSonnetCallsPerRun", "updatedAt") SELECT "id", "maxSonnetCallsPerRun", "updatedAt" FROM "AuditSettings";
DROP TABLE "AuditSettings";
ALTER TABLE "new_AuditSettings" RENAME TO "AuditSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
