import { spawn } from "child_process";

export class ExecResult {
  stdout = "";
  stderr = "";
  exitCode: number | null = null;
}

/**
 * Executes a command with arguments and returns the result.
 *
 * @param command The executable command (e.g., "git", "npm").
 * @param args Array of arguments to pass to the command.
 * @param options Additional spawn options and behavior flags.
 * @returns Promise resolving to an ExecResult containing stdout, stderr, and exit code.
 */
export async function exec(
  command: string,
  args: string[] = [],
  options: {
    allowNonZeroExit?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {}
): Promise<ExecResult> {
  const {
    allowNonZeroExit = false,
    cwd,
    env,
    timeoutMs,
  } = options;

  // Log the command being executed (useful for debugging)
  process.stdout.write(`EXEC: ${command} ${args.join(" ")}\n`);

  return new Promise((resolve, reject) => {
    const execResult = new ExecResult();

    const spawnOptions: Parameters<typeof spawn>[2] = {
      cwd,
      env: env ?? process.env,
      shell: false, // Security: avoid shell interpretation unless explicitly needed
      stdio: "pipe",
    };

    const cp = spawn(command, args, spawnOptions);

    // Capture stdout
    cp.stdout?.on("data", (data) => {
      const chunk = data.toString();
      process.stdout.write(chunk);
      execResult.stdout += chunk;
    });

    // Capture stderr
    cp.stderr?.on("data", (data) => {
      const chunk = data.toString();
      process.stderr.write(chunk);
      execResult.stderr += chunk;
    });

    // Handle process errors (e.g., command not found)
    cp.on("error", (err) => {
      reject(err);
    });

    // Optional timeout
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        cp.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    // Process completion
    cp.on("close", (code) => {
      clearTimeout(timeout);
      execResult.exitCode = code;

      if (code === 0 || allowNonZeroExit) {
        resolve(execResult);
      } else {
        const errorMessage = `Command failed with exit code ${code}\n` +
          `Command: ${command} ${args.join(" ")}\n` +
          `STDERR:\n${execResult.stderr.trim() || "(empty)"}`;
        reject(new Error(errorMessage));
      }
    });
  });
}