import { join, dirname, basename } from "node:path";
import { readdirSync } from "node:fs";

/**
 * Returns additional filesystem paths to append to the sandbox's denyRead list.
 *
 * Blocks system credential files, root's home directory, password manager data
 * dirs, and other users' home directories.
 *
 * @param home - The user's home directory
 */
export function extraDenyRead(home: string): string[] {
  const denied: string[] = [
    // System credential / privilege files
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/sudoers.d",
    // Root's home directory
    "/root",
    // Sensitive dirs under .local/share — inside the required .local root
    // so not reachable by the standard first-level $HOME enumeration
    join(home, ".local", "share", "keyrings"),
    join(home, ".local", "share", "gnome-keyring"),
    join(home, ".local", "share", "pass"),
    join(home, ".local", "share", "org.keepassxc.KeePassXC"),
  ];

  // Deny sibling home directories so other users' files are not reachable
  const homeParent = dirname(home);
  const currentUsername = basename(home);
  if (homeParent !== home) {
    try {
      for (const name of readdirSync(homeParent)) {
        if (name !== currentUsername) {
          denied.push(join(homeParent, name));
        }
      }
    } catch { /* non-standard home layout or unreadable parent */ }
  }

  return denied;
}
