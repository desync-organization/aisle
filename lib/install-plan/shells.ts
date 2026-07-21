import {
  InstallPlanError,
  MAX_PASTEABLE_COMMAND_LENGTH,
  type InstallShell,
} from "./contracts";
import type { InstallExecutionStep } from "./planner";

export type ShellCommands = Readonly<Record<InstallShell, string>>;

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/;
const CMD_NPX_EXECUTABLE = "npx.cmd";

function assertRenderableArgument(value: string): void {
  if (controlCharacterPattern.test(value)) {
    throw new InstallPlanError(
      "INVALID_INPUT",
      "Executable arguments cannot contain control characters.",
    );
  }
}

export function quotePosixArgument(value: string): string {
  assertRenderableArgument(value);
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function quotePowerShellArgument(value: string): string {
  assertRenderableArgument(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteCmdArgument(value: string): string {
  assertRenderableArgument(value);

  // cmd.exe expands percent variables even inside quotes, and delayed
  // expansion can expand exclamation marks. Neither can be made reliably
  // literal in a command intended for arbitrary interactive cmd settings.
  if (/[%!"]/.test(value)) {
    throw new InstallPlanError(
      "INVALID_INPUT",
      "cmd arguments cannot contain percent signs, exclamation marks, or quotes.",
    );
  }

  // Backslashes are passed to the native Windows argv parser. Double a
  // trailing run so it cannot escape the closing quote.
  const trailingBackslashes = value.match(/\\+$/)?.[0] ?? "";
  const escaped = trailingBackslashes
    ? `${value.slice(0, -trailingBackslashes.length)}${trailingBackslashes.repeat(2)}`
    : value;

  return `"${escaped}"`;
}

function allArguments(step: InstallExecutionStep): readonly string[] {
  return [step.file, ...step.args];
}

function renderPosixStep(step: InstallExecutionStep): string {
  return allArguments(step).map(quotePosixArgument).join(" ");
}

function renderPowerShellStep(step: InstallExecutionStep): string {
  return `& ${allArguments(step).map(quotePowerShellArgument).join(" ")}`;
}

function renderCmdStep(step: InstallExecutionStep): string {
  // `"npx"` makes cmd.exe resolve the extensionless Unix shim before
  // npx.cmd on standard Node.js for Windows installations. The executable is
  // a fixed planner token; only argv values pass through the cmd quoter.
  return [CMD_NPX_EXECUTABLE, ...step.args.map(quoteCmdArgument)].join(" ");
}

function renderPowerShell51(steps: readonly InstallExecutionStep[]): string {
  const statements = steps.flatMap((step, index) => [
    renderPowerShellStep(step),
    `if ((-not $?) -or ($LASTEXITCODE -ne 0)) { throw 'Aisle install step ${index + 1} failed; later steps were not run.' }`,
  ]);

  return `& { ${statements.join("; ")} }`;
}

function assertCommandLengths(commands: ShellCommands): void {
  for (const [shell, command] of Object.entries(commands)) {
    if (
      command.length > MAX_PASTEABLE_COMMAND_LENGTH ||
      Buffer.byteLength(command, "utf8") > MAX_PASTEABLE_COMMAND_LENGTH
    ) {
      throw new InstallPlanError(
        "COMMAND_TOO_LONG",
        `The ${shell} command exceeds the ${MAX_PASTEABLE_COMMAND_LENGTH}-character safety cap.`,
        [{ path: `commands.${shell}`, message: "command is too long" }],
      );
    }
  }
}

export function renderShellCommands(
  steps: readonly InstallExecutionStep[],
): ShellCommands {
  const commands: ShellCommands = {
    posix: steps.map(renderPosixStep).join(" && "),
    powershell7: steps.map(renderPowerShellStep).join(" && "),
    powershell51: renderPowerShell51(steps),
    cmd: steps.map(renderCmdStep).join(" && "),
  };

  assertCommandLengths(commands);
  return commands;
}
