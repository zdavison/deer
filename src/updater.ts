import pkg from "../package.json";

const CURRENT_VERSION = pkg.version;
const REPO = "zdavison/deer";

function getPlatformBinaryName(): string | null {
  const os = process.platform;
  const cpu = process.arch;
  if (os === "linux" && cpu === "x64") return "deer-linux-x64";
  if (os === "linux" && cpu === "arm64") return "deer-linux-arm64";
  if (os === "darwin" && cpu === "x64") return "deer-darwin-x64";
  if (os === "darwin" && cpu === "arm64") return "deer-darwin-arm64";
  return null;
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map(Number);
  const [lM, lm, lp] = parse(latest);
  const [cM, cm, cp] = parse(current);
  if (lM !== cM) return lM > cM;
  if (lm !== cm) return lm > cm;
  return lp > cp;
}

function isDevMode(): boolean {
  const script = process.argv[1] ?? "";
  return script.endsWith(".ts") || script.endsWith(".tsx");
}

/**
 * Checks GitHub releases for a newer version. If found, downloads and replaces
 * the current binary, then re-execs the new binary and never returns.
 * Returns false if up to date or if the check/update fails (non-fatal).
 */
export async function checkAndUpdate(): Promise<boolean> {
  if (isDevMode()) return false;

  let release: { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": `deer/${CURRENT_VERSION}`,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return false;
    release = (await res.json()) as typeof release;
  } catch {
    return false;
  }

  const latestVersion = release.tag_name.replace(/^v/, "");
  if (!isNewer(latestVersion, CURRENT_VERSION)) return false;

  const binaryName = getPlatformBinaryName();
  if (!binaryName) return false;

  const asset = release.assets.find((a) => a.name === binaryName);
  if (!asset) return false;

  process.stdout.write(
    `deer: updating v${CURRENT_VERSION} → v${latestVersion}...\n`
  );

  let data: ArrayBuffer;
  try {
    const res = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return false;
    data = await res.arrayBuffer();
  } catch {
    process.stdout.write(`deer: update download failed, continuing with current version\n`);
    return false;
  }

  const currentPath = process.execPath;
  const tmpPath = `${currentPath}.update-tmp`;

  try {
    await Bun.write(tmpPath, data);
    await Bun.$`chmod +x ${tmpPath}`.quiet();
    await Bun.$`mv ${tmpPath} ${currentPath}`.quiet();
  } catch {
    await Bun.$`rm -f ${tmpPath}`.quiet();
    process.stdout.write(`deer: update install failed, continuing with current version\n`);
    return false;
  }

  process.stdout.write(`deer: updated to v${latestVersion}, restarting...\n`);

  // Re-exec the new binary, replacing this process
  const proc = Bun.spawn([currentPath, ...process.argv.slice(1)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
