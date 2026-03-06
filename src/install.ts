import { join } from "node:path";
import { accessSync, constants } from "node:fs";

const INSTALL_PATH = "/usr/local/bin/deer";

export async function installDeer(): Promise<void> {
  // import.meta.dir is src/, go up one level to the package root
  const packageRoot = join(import.meta.dir, "..");
  const entrypoint = join(packageRoot, "src", "cli.tsx");

  // Verify the source entrypoint exists (sanity check)
  try {
    accessSync(entrypoint, constants.R_OK);
  } catch {
    console.error(`Error: source file not found at ${entrypoint}`);
    process.exit(1);
  }

  console.log("Compiling deer (this may take a moment)...");

  const result = Bun.spawnSync(
    ["bun", "build", "--compile", entrypoint, "--outfile", INSTALL_PATH],
    { stdio: ["inherit", "inherit", "inherit"] },
  );

  if (result.exitCode !== 0) {
    if (result.exitCode === 1) {
      console.error(
        `\nInstall failed. If this is a permission error, try:\n  sudo bunx @zdavison/deer install`,
      );
    }
    process.exit(result.exitCode ?? 1);
  }

  console.log(`\nInstalled deer to ${INSTALL_PATH}`);
  console.log("Run 'deer' to launch.");
}
