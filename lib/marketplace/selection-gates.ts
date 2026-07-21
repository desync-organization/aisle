export const catalogSelectionGateReasons = [
  "lifecycle-not-current",
  "revision-evidence-missing",
  "install-unresolved",
  "source-verification-unavailable",
  "source-revision-changed",
  "selector-scope-ambiguous",
  "source-inactive",
  "license-not-eligible",
  "license-evidence-missing",
  "trust-pending",
  "trust-blocked",
  "upstream-audit-failed",
] as const;

export type CatalogSelectionGateReason = (typeof catalogSelectionGateReasons)[number];
export type CatalogTrustState = "unreviewed" | "pass" | "warn" | "blocked";

export const catalogSelectionGateCopy: Readonly<Record<CatalogSelectionGateReason, string>> = {
  "lifecycle-not-current": "The upstream listing is stale and must be refreshed.",
  "revision-evidence-missing": "Immutable revision evidence is incomplete.",
  "install-unresolved": "A safe install target has not been resolved.",
  "source-verification-unavailable": "The public source could not be reverified just now.",
  "source-revision-changed": "The public branch moved after this revision was cataloged.",
  "selector-scope-ambiguous": "The reviewed source scope no longer resolves to exactly one skill.",
  "source-inactive": "No current public source listing is available.",
  "license-not-eligible": "The detected license is not currently eligible.",
  "license-evidence-missing": "Verified license evidence is missing.",
  "trust-pending": "Trust review has not completed for this revision.",
  "trust-blocked": "Trust review blocked this revision.",
  "upstream-audit-failed": "The latest upstream audit failed.",
};
