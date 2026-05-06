import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function buildContracts(ctx: {
  paths: { deploymentRoot: string };
  config: {
    build: { target: string; oracleBinaryPath: string; guardianSetBinaryPath: string };
  };
}): Promise<void> {
  const repoRoot = path.resolve(ctx.paths.deploymentRoot, "..");
  const target = ctx.config.build.target;
  execSync(
    `cargo build -p oracle_script -p guardian_set_script --release --target ${target}`,
    { cwd: path.join(repoRoot, "crates", "lean_oracle"), stdio: "inherit" },
  );

  for (const relPath of [
    ctx.config.build.oracleBinaryPath,
    ctx.config.build.guardianSetBinaryPath,
  ]) {
    const abs = path.resolve(repoRoot, relPath);
    if (!fs.existsSync(abs)) throw new Error(`Expected build output missing: ${abs}`);
    if (fs.statSync(abs).size === 0) throw new Error(`Build output is empty: ${abs}`);
  }
}
