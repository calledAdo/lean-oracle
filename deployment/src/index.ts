import "dotenv/config";

import { buildContracts } from "./build.js";
import { loadDeploymentContext } from "./config.js";
import { writeDeploymentActionArtifacts } from "./artifacts.js";
import { runDeploymentAction } from "./deploy.js";
import { validateConfigPreflight } from "./validate.js";

const argv = process.argv.slice(2);
const ctx = loadDeploymentContext(argv);

if (ctx.action === "validate:config") {
  const { exitCode, lines } = validateConfigPreflight({
    deploymentRoot: ctx.paths.deploymentRoot,
    argv: argv.slice(1),
    env: process.env,
  });
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
  // No side effects for validate:config.
} else {
// Only code-deployment actions need a contract build phase.
  if (
    ctx.action === "deploy:guardian-set-type" ||
    ctx.action === "deploy:oracle-type" ||
    ctx.action === "deploy:owned-type-bind-lock"
  ) {
    await buildContracts(ctx);
  }
  const result = await runDeploymentAction(ctx);
  const { artifactPaths } = writeDeploymentActionArtifacts(
    ctx.paths.deploymentRoot,
    ctx.network,
    ctx.action,
    result,
  );
  for (const artifactPath of artifactPaths) {
    console.log(`Wrote deployment artifact: ${artifactPath}`);
  }
}
