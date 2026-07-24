/*
  Warnings:

  - Added the required column `auditedSessionId` to the `AnalysisNote` table without a default value. This is not possible if the table is not empty.
  - Added the required column `auditedSessionId` to the `RuleProposal` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "AuditedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptSessionId" TEXT NOT NULL,
    "projectSlug" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditedSession_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "AuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AnalysisNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditedSessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisNote_auditedSessionId_fkey" FOREIGN KEY ("auditedSessionId") REFERENCES "AuditedSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AnalysisNote" ("createdAt", "evidence", "id", "kind") SELECT "createdAt", "evidence", "id", "kind" FROM "AnalysisNote";
DROP TABLE "AnalysisNote";
ALTER TABLE "new_AnalysisNote" RENAME TO "AnalysisNote";
CREATE INDEX "AnalysisNote_auditedSessionId_idx" ON "AnalysisNote"("auditedSessionId");
CREATE TABLE "new_RuleProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditedSessionId" TEXT NOT NULL,
    "targetRuleRef" TEXT NOT NULL,
    "targetTextSnapshot" TEXT NOT NULL,
    "proposedText" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuleProposal_auditedSessionId_fkey" FOREIGN KEY ("auditedSessionId") REFERENCES "AuditedSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RuleProposal" ("createdAt", "evidence", "id", "proposedText", "status", "targetRuleRef", "targetTextSnapshot") SELECT "createdAt", "evidence", "id", "proposedText", "status", "targetRuleRef", "targetTextSnapshot" FROM "RuleProposal";
DROP TABLE "RuleProposal";
ALTER TABLE "new_RuleProposal" RENAME TO "RuleProposal";
CREATE INDEX "RuleProposal_status_idx" ON "RuleProposal"("status");
CREATE INDEX "RuleProposal_auditedSessionId_idx" ON "RuleProposal"("auditedSessionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AuditedSession_auditRunId_idx" ON "AuditedSession"("auditRunId");

-- CreateIndex
CREATE INDEX "AuditedSession_transcriptSessionId_idx" ON "AuditedSession"("transcriptSessionId");
