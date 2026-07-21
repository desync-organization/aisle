export const individuallySelectableLicenseIds = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "MPL-2.0",
  "CC0-1.0",
  "Unlicense",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
] as const;

const individuallySelectableLicenseSet = new Set<string>(
  individuallySelectableLicenseIds,
);

export function isIndividuallySelectableLicense(value: string): boolean {
  return individuallySelectableLicenseSet.has(value);
}

export function publicLicenseLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 256 || /[\u0000-\u001f\u007f]/u.test(label)) {
    return "unknown";
  }
  return label;
}
