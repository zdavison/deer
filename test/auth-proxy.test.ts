import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isRealBinary } from "../packages/deerbox/src/sandbox/auth-proxy";

describe("isRealBinary", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-isrealbinary-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Mach-O magic numbers (macOS)
  test("returns true for Mach-O 64-bit little-endian binary (CF FA ED FE)", async () => {
    const path = join(tmpDir, "macho-64-le");
    await writeFile(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x00]));
    expect(isRealBinary(path)).toBe(true);
  });

  test("returns true for Mach-O 32-bit little-endian binary (CE FA ED FE)", async () => {
    const path = join(tmpDir, "macho-32-le");
    await writeFile(path, Buffer.from([0xce, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x00]));
    expect(isRealBinary(path)).toBe(true);
  });

  test("returns true for Mach-O fat/universal binary (CA FE BA BE)", async () => {
    const path = join(tmpDir, "macho-fat");
    await writeFile(path, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]));
    expect(isRealBinary(path)).toBe(true);
  });

  // ELF magic number (Linux)
  test("returns true for ELF binary (7F 45 4C 46)", async () => {
    const path = join(tmpDir, "elf");
    await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
    expect(isRealBinary(path)).toBe(true);
  });

  // Shell-script shims (nodenv, asdf) on both macOS and Linux are plain
  // bash scripts with #! shebang lines. The magic byte is 0x23 ('#').
  test("returns false for nodenv-style bash shim", async () => {
    const path = join(tmpDir, "nodenv-shim");
    await writeFile(
      path,
      '#!/usr/bin/env bash\nset -e\n[ -n "$NODENV_DEBUG" ] && set -x\n\nprogram="${0##*/}"\nexec nodenv exec "$program" "$@"\n',
    );
    await chmod(path, 0o755);
    expect(isRealBinary(path)).toBe(false);
  });

  test("returns false for asdf-style bash shim", async () => {
    const path = join(tmpDir, "asdf-shim");
    await writeFile(
      path,
      '#!/usr/bin/env bash\n# asdf-plugin: nodejs\nexec /usr/local/opt/asdf/libexec/bin/asdf exec "$@"\n',
    );
    await chmod(path, 0o755);
    expect(isRealBinary(path)).toBe(false);
  });

  test("returns false for sh shebang", async () => {
    const path = join(tmpDir, "sh-script");
    await writeFile(path, "#!/bin/sh\necho hello\n");
    await chmod(path, 0o755);
    expect(isRealBinary(path)).toBe(false);
  });

  test("returns false for non-existent file", () => {
    expect(isRealBinary(join(tmpDir, "does-not-exist"))).toBe(false);
  });

  test("returns false for empty file", async () => {
    const path = join(tmpDir, "empty");
    await writeFile(path, "");
    expect(isRealBinary(path)).toBe(false);
  });

  test("returns false for plain text file", async () => {
    const path = join(tmpDir, "text");
    await writeFile(path, "just some text, not a binary\n");
    expect(isRealBinary(path)).toBe(false);
  });

  // Sanity check: the actual Node.js binary on the test machine should be real
  test("returns true for the running Node binary", () => {
    expect(isRealBinary(process.execPath)).toBe(true);
  });
});
