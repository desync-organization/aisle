// @vitest-environment node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogDatabase, type CatalogDatabaseConnection } from "./client";
import { migrateCatalogDatabase } from "./migrate";

const currentMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

function oldMigrationFolder(parent: string): string {
  const folder = join(parent, "ddd430d-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  copyFileSync(
    join(currentMigrations, "0000_catalog-foundation.sql"),
    join(folder, "0000_catalog-foundation.sql"),
  );
  copyFileSync(
    join(currentMigrations, "0001_skills-sh-hydration-cache.sql"),
    join(folder, "0001_skills-sh-hydration-cache.sql"),
  );
  const journal = JSON.parse(
    readFileSync(join(currentMigrations, "meta", "_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: unknown[] };
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }, null, 2),
  );
  return folder;
}

async function columnNames(connection: CatalogDatabaseConnection, table: string) {
  const result = await connection.client.execute(`pragma table_info('${table}')`);
  return result.rows.map((row) => String(row.name));
}

describe("catalog migrations", () => {
  const connections: CatalogDatabaseConnection[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.client.close();
  });

  it("upgrades an actual ddd430d database through 0002/0003 without losing rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aisle-upgrade-test-"));
    const connection = createCatalogDatabase({
      url: `file:${join(directory, "catalog.db").replaceAll("\\", "/")}`,
    });
    connections.push(connection);
    await migrateCatalogDatabase(connection.client, oldMigrationFolder(directory));
    const now = Date.now();
    await connection.client.batch(
      [
        {
          sql: "insert into catalog_sources (id,name,base_url,mode,upstream_identifier,created_at,updated_at) values (?,?,?,?,?,?,?)",
          args: ["legacy-source", "Legacy", "https://example.com", "full", "legacy", now, now],
        },
        {
          sql: "insert into skills (id,canonical_key,provider,source_url,skill_path,upstream_name,license,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)",
          args: [
            "legacy-skill",
            "github:https://github.com/example/legacy:fixture-safe",
            "github",
            "https://github.com/example/legacy",
            "fixture-safe",
            "fixture-safe",
            "MIT",
            now,
            now,
          ],
        },
        {
          sql: "insert into skill_revisions (id,skill_id,immutable_ref,content_hash,install_url,is_current,first_seen_at,last_seen_at) values (?,?,?,?,?,?,?,?)",
          args: [
            "legacy-revision",
            "legacy-skill",
            "a".repeat(40),
            "b".repeat(64),
            "https://github.com/example/legacy",
            1,
            now,
            now,
          ],
        },
      ],
      "write",
    );

    await migrateCatalogDatabase(connection.client, currentMigrations);

    expect(await columnNames(connection, "sync_runs")).toEqual(
      expect.arrayContaining(["lease_token", "lease_expires_at"]),
    );
    expect(await columnNames(connection, "skill_revisions")).toContain("install_spec_json");
    expect(await columnNames(connection, "trust_assessments")).toEqual(
      expect.arrayContaining(["immutable_ref", "content_hash"]),
    );
    const revision = await connection.client.execute(
      "select id, install_spec_json from skill_revisions where id = 'legacy-revision'",
    );
    expect(revision.rows[0]).toMatchObject({
      id: "legacy-revision",
      install_spec_json: "{}",
    });
  });

  it("builds the complete schema from a fresh database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aisle-fresh-migration-test-"));
    const connection = createCatalogDatabase({
      url: `file:${join(directory, "catalog.db").replaceAll("\\", "/")}`,
    });
    connections.push(connection);
    await migrateCatalogDatabase(connection.client, currentMigrations);
    const tables = await connection.client.execute(
      "select name from sqlite_master where type='table' order by name",
    );
    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "skill_duplicates",
        "skill_revisions",
        "sync_runs",
        "trust_assessments",
      ]),
    );
    const indexes = await connection.client.execute(
      "select name from sqlite_master where type='index'",
    );
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "sync_runs_one_running_per_source_uidx",
        "skill_revisions_id_skill_uidx",
      ]),
    );
  });
});
