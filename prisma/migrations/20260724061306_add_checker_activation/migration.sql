-- CreateTable
CREATE TABLE "CheckerActivation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rulebookHash" TEXT NOT NULL,
    "checkerId" TEXT NOT NULL,
    "activated" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckerActivation_rulebookHash_checkerId_key" ON "CheckerActivation"("rulebookHash", "checkerId");
