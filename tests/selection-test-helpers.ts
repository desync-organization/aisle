import {
  catalogSkillIdSchema,
  type CatalogSkillId,
  type SelectionStorage,
} from "@/lib/selection";

export function catalogId(value: string): CatalogSkillId {
  return catalogSkillIdSchema.parse(value);
}

export class MemorySelectionStorage implements SelectionStorage {
  readonly values = new Map<string, string>();
  readonly removedKeys: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removedKeys.push(key);
    this.values.delete(key);
  }
}
