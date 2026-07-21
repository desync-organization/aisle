export const packageBindingIssues = [
  "publication-metadata-missing",
  "schema-version-mismatch",
  "blueprint-digest-mismatch",
  "editorial-mismatch",
  "member-count-mismatch",
  "member-locator-mismatch",
  "member-revision-mismatch",
  "member-license-mismatch",
] as const;

export type PackageBindingIssue = (typeof packageBindingIssues)[number];

export const packageBindingIssueCopy: Readonly<Record<PackageBindingIssue, string>> = {
  "publication-metadata-missing": "The published version is missing its immutable blueprint receipt.",
  "schema-version-mismatch": "The published schema version differs from the displayed blueprint.",
  "blueprint-digest-mismatch": "The published digest does not match the displayed blueprint.",
  "editorial-mismatch": "The published editorial payload differs from the page being shown.",
  "member-count-mismatch": "The published member set is incomplete or contains extra rows.",
  "member-locator-mismatch": "A published upstream name, repository, or skill path does not match.",
  "member-revision-mismatch": "A published member is not bound to the displayed observed revision.",
  "member-license-mismatch": "A published member license differs from the displayed evidence.",
};

export type PublishedPackageBinding = Readonly<{
  versionId: string;
  version: number;
  blueprintSchemaVersion: number;
  blueprintDigest: string;
  editorial: Readonly<Record<string, unknown>>;
}>;

export type PublishedPackageMemberBinding = Readonly<{
  position: number;
  skillId: string;
  name: string;
  sourceUrl: string;
  skillPath: string;
  revisionId: string;
  immutableRef: string;
  contentHash: string;
  license: string;
  trustState: "pass" | "warn";
}>;
