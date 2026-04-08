import type { RiskyEnvVar, EnvPolicy } from "./env-check";

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `\r${ESC}[2K`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
const yellow = (s: string) => `${ESC}[33m${s}${ESC}[39m`;
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[39m`;

/**
 * Show an interactive terminal multi-select for unreviewed risky env vars.
 *
 * The user navigates with ↑/↓, toggles with space, and confirms with enter.
 * Vars start unchecked (blocked) by default — the safe choice.
 *
 * If stdin is not a TTY, all vars are auto-blocked without showing UI.
 *
 * Returns the updated policy with user decisions merged into the existing one.
 */
export async function runEnvReview(
  unreviewedVars: RiskyEnvVar[],
  existingPolicy: EnvPolicy,
): Promise<EnvPolicy> {
  if (unreviewedVars.length === 0) return existingPolicy;

  // Non-interactive fallback: auto-block all unreviewed vars
  if (!process.stdin.isTTY) {
    return {
      blocked: [...existingPolicy.blocked, ...unreviewedVars.map((v) => v.key)],
      approved: [...existingPolicy.approved],
    };
  }

  const out = process.stderr;
  // Pre-check vars the user has already approved so their state is visible
  const checked = new Set<string>(
    unreviewedVars.filter((v) => existingPolicy.approved.includes(v.key)).map((v) => v.key),
  );
  let cursor = 0;

  const FOOTER_LINES = 2;
  let renderedLines = 0;

  const renderList = () => {
    // Move cursor up past previously rendered lines
    if (renderedLines > 0) {
      out.write(`${ESC}[${renderedLines}A`);
    }

    const lines: string[] = [];
    for (let i = 0; i < unreviewedVars.length; i++) {
      const v = unreviewedVars[i];
      const isCursor = i === cursor;
      const isChecked = checked.has(v.key);
      const arrow = isCursor ? cyan("▶") : " ";
      const box = isChecked ? `[${bold("x")}]` : "[ ]";
      const key = v.key.padEnd(32);
      const reason = dim(`(${v.reason})`).padEnd(28);
      lines.push(`  ${arrow} ${box} ${key} ${reason} ${dim(v.displayValue)}`);
    }
    lines.push("");
    lines.push(
      dim("  ↑/↓ navigate  space toggle  enter confirm") +
      "   " +
      yellow("unchecked = blocked"),
    );

    for (const line of lines) {
      out.write(`${CLEAR_LINE}${line}\n`);
    }

    renderedLines = lines.length;
  };

  const buildPolicy = (): EnvPolicy => {
    const newBlocked = [...existingPolicy.blocked];
    const newApproved = [...existingPolicy.approved];
    for (const v of unreviewedVars) {
      if (checked.has(v.key)) {
        newApproved.push(v.key);
      } else {
        newBlocked.push(v.key);
      }
    }
    return { blocked: newBlocked, approved: newApproved };
  };

  // Print static header
  out.write("\n");
  out.write(`  ${yellow("⚠")}  ${bold("Risky environment variables detected")}\n`);
  out.write(`  ${dim("─────────────────────────────────────────────────────────────────")}\n`);
  out.write(`  These env vars may contain secrets. Select which to ${bold("allow")} in the\n`);
  out.write(`  sandbox — unchecked vars will be blocked. Your choice is remembered.\n`);
  out.write("\n");

  out.write(HIDE_CURSOR);
  renderList();

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      out.write(SHOW_CURSOR);
      out.write("\n");
    };

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        // Confirm
        cleanup();
        resolve(buildPolicy());
      } else if (key === "\x03") {
        // Ctrl+C — restore terminal and exit
        cleanup();
        process.exit(1);
      } else if (key === `${ESC}[A`) {
        // Up arrow
        cursor = Math.max(0, cursor - 1);
        renderList();
      } else if (key === `${ESC}[B`) {
        // Down arrow
        cursor = Math.min(unreviewedVars.length - 1, cursor + 1);
        renderList();
      } else if (key === " ") {
        // Space — toggle selection
        const varKey = unreviewedVars[cursor].key;
        if (checked.has(varKey)) {
          checked.delete(varKey);
        } else {
          checked.add(varKey);
        }
        renderList();
      }
    };

    process.stdin.on("data", onData);
  });
}
