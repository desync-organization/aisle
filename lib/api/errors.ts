import type { ApiFieldIssue } from "./contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldIssues?: readonly ApiFieldIssue[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}
