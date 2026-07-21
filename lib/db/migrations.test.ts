// @vitest-environment node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogDatabase, type CatalogDatabaseConnection } from "./client";
import { migrateCatalogDatabase } from "./migrate";
import { CatalogRepository } from "./repository";

const currentMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

function c890314MigrationFolder(parent: string): string {
  const folder = join(parent, "c890314-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const migration of [
    "0000_catalog-foundation.sql",
    "0001_skills-sh-hydration-cache.sql",
    "0002_source-normalization.sql",
    "0003_soft_bucky.sql",
  ]) {
    copyFileSync(join(currentMigrations, migration), join(folder, migration));
  }
  const journal = JSON.parse(
    readFileSync(join(currentMigrations, "meta", "_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: unknown[] };
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 4) }, null, 2),
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

  it("corrects a c890314-through-0003 database without trusting or publishing legacy corruption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aisle-upgrade-test-"));
    const connection = createCatalogDatabase({
      url: `file:${join(directory, "catalog.db").replaceAll("\\", "/")}`,
    });
    connections.push(connection);
    await migrateCatalogDatabase(connection.client, c890314MigrationFolder(directory));
    await connection.client.execute("drop index sync_runs_one_running_per_source_uidx");
    await connection.client.execute("pragma foreign_keys=off");
    const now = Date.now();
    await connection.client.batch(
      [
        {
          sql: "insert into catalog_sources (id,name,base_url,mode,upstream_identifier,created_at,updated_at) values (?,?,?,?,?,?,?)",
          args: ["legacy-source", "Legacy", "https://example.com", "full", "legacy", now, now],
        },
        {
          sql: "insert into sync_runs (id,source_id,status,started_at) values (?,?,?,?)",
          args: ["legacy-run-old", "legacy-source", "running", now - 1],
        },
        {
          sql: "insert into sync_runs (id,source_id,status,started_at) values (?,?,?,?)",
          args: ["legacy-run-new", "legacy-source", "running", now],
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
        {
          sql: "insert into trust_assessments (id,revision_id,scanner,scanner_version,state,quarantine_reason,scanned_at) values (?,?,?,?,?,?,?)",
          args: ["legacy-assessment", "legacy-revision", "legacy-scanner", "1", "pass", null, now],
        },
        {
          sql: "insert into skills (id,canonical_key,provider,source_url,skill_path,upstream_name,license,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)",
          args: [
            "legacy-audit-skill",
            "skills-sh:https://github.com/example/audit:fixture-audit",
            "skills-sh",
            "https://github.com/example/audit",
            "fixture-audit",
            "fixture-audit",
            "MIT",
            now,
            now,
          ],
        },
        {
          sql: `insert into skill_revisions
            (id,skill_id,immutable_ref,content_hash,upstream_hash,install_url,install_spec_json,license,is_current,first_seen_at,last_seen_at)
            values (?,?,?,?,?,?,?,?,?,?,?)`,
          args: [
            "legacy-audit-revision",
            "legacy-audit-skill",
            "provider-revision-v1",
            "e".repeat(64),
            "e".repeat(64),
            "https://skills.sh/example/audit/fixture-audit",
            JSON.stringify({
              kind: "registry",
              registry: "skills.sh",
              identifier: "example/audit/fixture-audit",
              version: "provider-revision-v1",
            }),
            "MIT",
            1,
            now,
            now,
          ],
        },
        {
          sql: "insert into trust_assessments (id,revision_id,scanner,scanner_version,state,quarantine_reason,scanned_at) values (?,?,?,?,?,?,?)",
          args: ["legacy-audit-assessment", "legacy-audit-revision", "legacy-scanner", "1", "pass", null, now],
        },
        {
          sql: `insert into source_listings
            (id,source_id,upstream_id,skill_id,source_type,source_hash,status,raw_json,first_seen_at,last_seen_at)
            values (?,?,?,?,?,?,?,?,?,?)`,
          args: [
            "legacy-audit-listing",
            "legacy-source",
            "example/audit/fixture-audit",
            "legacy-audit-skill",
            "skills-sh",
            "provider-revision-v1",
            "current",
            "{}",
            now,
            now,
          ],
        },
        {
          sql: `insert into audit_records
            (id,source_listing_id,scope,provider,provider_slug,status,summary,upstream_content_hash,observed_at,raw_json)
            values (?,?,?,?,?,?,?,?,?,?)`,
          args: [
            "legacy-audit-fail",
            "legacy-audit-listing",
            "observation",
            "fixture-auditor",
            "fixture",
            "fail",
            "Inert legacy failure fixture.",
            "provider-revision-v1",
            now,
            "{}",
          ],
        },
        {
          sql: "insert into skills (id,canonical_key,provider,source_url,skill_path,upstream_name,license,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)",
          args: [
            "legacy-skill-two",
            "github:https://github.com/example/legacy-two:fixture-safe",
            "github",
            "https://github.com/example/legacy-two",
            "fixture-safe",
            "fixture-safe-two",
            "MIT",
            now,
            now,
          ],
        },
        {
          sql: "insert into skill_revisions (id,skill_id,immutable_ref,content_hash,install_url,is_current,first_seen_at,last_seen_at) values (?,?,?,?,?,?,?,?)",
          args: [
            "legacy-revision-two",
            "legacy-skill-two",
            "c".repeat(40),
            "d".repeat(64),
            "https://github.com/example/legacy-two",
            1,
            now,
            now,
          ],
        },
        {
          sql: "insert into packages (id,slug,title,description,published,created_at,updated_at) values (?,?,?,?,?,?,?)",
          args: ["legacy-package", "legacy-package", "Legacy", "Legacy fixture", 1, now, now],
        },
        {
          sql: "insert into package_versions (id,package_id,version,published_at,created_at) values (?,?,?,?,?)",
          args: ["legacy-package-v1", "legacy-package", 1, now, now],
        },
        {
          sql: "insert into package_members (package_version_id,skill_id,revision_id,position,selected_by_default) values (?,?,?,?,?)",
          args: ["legacy-package-v1", "legacy-skill", "legacy-revision", 0, 1],
        },
        {
          sql: "insert into package_members (package_version_id,skill_id,revision_id,position,selected_by_default) values (?,?,?,?,?)",
          args: ["legacy-package-v1", "legacy-skill-two", "legacy-revision", 1, 1],
        },
      ],
      "write",
    );
    await connection.client.execute("pragma foreign_keys=on");

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
    const assessment = await connection.client.execute(
      "select immutable_ref, content_hash, state from trust_assessments where id = 'legacy-assessment'",
    );
    expect(assessment.rows[0]).toMatchObject({
      immutable_ref: "a".repeat(40),
      content_hash: "b".repeat(64),
      state: "unreviewed",
    });
    const auditAssessment = await connection.client.execute(
      "select state from trust_assessments where id = 'legacy-audit-assessment'",
    );
    expect(auditAssessment.rows[0]).toMatchObject({ state: "unreviewed" });
    const auditRevision = await connection.client.execute(
      "select upstream_hash from skill_revisions where id = 'legacy-audit-revision'",
    );
    expect(auditRevision.rows[0]).toMatchObject({ upstream_hash: null });
    const runs = await connection.client.execute(
      "select id, status from sync_runs order by id",
    );
    expect(runs.rows).toEqual([
      expect.objectContaining({ id: "legacy-run-new", status: "running" }),
      expect.objectContaining({ id: "legacy-run-old", status: "partial" }),
    ]);
    const members = await connection.client.execute(
      "select skill_id, revision_id from package_members order by position",
    );
    expect(members.rows).toEqual([
      expect.objectContaining({ skill_id: "legacy-skill", revision_id: "legacy-revision" }),
    ]);
    const quarantinedMembers = await connection.client.execute(
      "select skill_id, revision_id, reason from package_member_quarantines",
    );
    expect(quarantinedMembers.rows).toEqual([
      expect.objectContaining({
        skill_id: "legacy-skill-two",
        revision_id: "legacy-revision",
        reason: "Revision does not belong to the package member skill",
      }),
    ]);
    const publication = await connection.client.execute(
      "select p.published, pv.published_at from packages p join package_versions pv on pv.package_id = p.id where p.id = 'legacy-package'",
    );
    expect(publication.rows[0]).toMatchObject({ published: 0, published_at: null });
    const foreignKeyCheck = await connection.client.execute("pragma foreign_key_check");
    expect(foreignKeyCheck.rows).toEqual([]);
    const repository = new CatalogRepository(connection.db);
    expect(await repository.search()).toEqual([]);
    expect(await repository.resolvePackage("legacy-package", 1)).toEqual([]);
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
        "source_listings_freshness_idx",
      ]),
    );
    expect(await columnNames(connection, "catalog_sources")).toContain("freshness_policy");
    expect(await columnNames(connection, "sync_runs")).toContain(
      "observation_sweep_complete",
    );
    expect(await columnNames(connection, "source_listings")).toContain(
      "last_completed_observation_run_id",
    );
  });
});
