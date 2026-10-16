import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';

const darwinSandboxExec = '/usr/bin/sandbox-exec';
export const PARSER_NETWORK_DENY_PROFILE = '(version 1)(allow default)(deny network*)';

export class ParserNetworkIsolationError extends Error {
  readonly code = 'PARSER_NETWORK_ISOLATION_UNAVAILABLE';
  constructor() {
    super('Heavy document parsing requires a per-process network sandbox; this platform cannot provide the configured isolation.');
    this.name = 'ParserNetworkIsolationError';
  }
}

/**
 * The worker is network-isolated on macOS by a process-local Seatbelt profile.
 * Other platforms fail closed until an equivalent per-process network deny rule is verified.
 * The profile limits network access only; it is not a filesystem sandbox.
 */
export async function parserWorkerCommand(
  platform: NodeJS.Platform,
  executable: string,
  args: string[],
): Promise<{ command: string; args: string[] }> {
  if (platform !== 'darwin') throw new ParserNetworkIsolationError();
  try {
    await access(darwinSandboxExec, fsConstants.X_OK);
  } catch {
    throw new ParserNetworkIsolationError();
  }
  return {
    command: darwinSandboxExec,
    args: ['-p', PARSER_NETWORK_DENY_PROFILE, executable, ...args],
  };
}
