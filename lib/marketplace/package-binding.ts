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
  "publication-metadata-missing": "The saved package information is incomplete.",
  "schema-version-mismatch": "The saved package uses a different format.",
  "blueprint-digest-mismatch": "The saved package does not match this page.",
  "editorial-mismatch": "The saved package details do not match this page.",
  "member-count-mismatch": "The saved package has missing or extra skills.",
  "member-locator-mismatch": "A skill name, repository, or path does not match.",
  "member-revision-mismatch": "A skill version does not match.",
  "member-license-mismatch": "A skill license does not match.",
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
