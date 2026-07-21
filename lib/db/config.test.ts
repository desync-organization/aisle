// @vitest-environment node

import { describe, expect, it } from "vitest";

import { resolveDatabaseConfig } from "./config";

describe("database configuration", () => {
  it("uses a credential-free local file database by default", () => {
    expect(resolveDatabaseConfig({})).toEqual({
      url: "file:./data/aisle.db",
      authToken: undefined,
    });
  });

  it("requires a token only for hosted libSQL", () => {
    expect(() =>
      resolveDatabaseConfig({ DATABASE_URL: "libsql://catalog.example.turso.io" }),
    ).toThrow(/DATABASE_AUTH_TOKEN/);

    expect(
      resolveDatabaseConfig({
        DATABASE_URL: "libsql://catalog.example.turso.io",
        DATABASE_AUTH_TOKEN: "short-lived-host-token",
      }),
    ).toEqual({
      url: "libsql://catalog.example.turso.io",
      authToken: "short-lived-host-token",
    });
  });
});
