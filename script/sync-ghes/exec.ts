#!/usr/bin/env npx ts-node
import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "./exec";
import { checkWorkflows, WorkflowsCheckResult, WorkflowDesc } from "./workflow-check";
import { rewriteWorkflow, addPlaceholderStep } from "./workflow-rewrite";
import { generateCodeowners } from "./codeowners-generate";

async function downgradeArtifactActions(
  workflows: WorkflowDesc[],
  readOnlyFolders: string[]
) {
  console.group("Downgrade artifact actions v4 → v3");
  for (const wf of workflows) {
    if (readOnlyFolders.includes(wf.folder)) continue;

    const path = join(wf.folder, `${wf.id}.yml`);
    const contents = await fs.readFile(path, "utf8");

    if (!contents.includes("@v4")) continue;

    console.log(`Updating ${path}`);
    let updated = contents.replace(/actions\/upload-artifact@v4/g, "actions/upload-artifact@v3");
    updated = updated.replace(/actions\/download-artifact@v4/g, "actions/download-artifact@v3");
    await fs.writeFile(path, updated);
  }
  console.groupEnd();
}

async function addPlaceholderToAll(
  workflows: WorkflowDesc[],
  readOnlyFolders: string[]
) {
  console.group("Adding placeholder step to all compatible workflows");
  for (const wf of workflows) {
    if (readOnlyFolders.includes(wf.folder)) continue;

    const path = join(wf.folder, `${wf.id}.yml`);
    await rewriteWorkflow(path, addPlaceholderStep);
  }
  console.groupEnd();
}

(async function main() {
  try {
    const settings = {
      folders: ["../../ci", "../../automation", "../../code-scanning", "../../pages"],
      readOnlyFolders: ["../../pages"],
      enabledActions: [
        "actions/cache",
        "actions/checkout",
        "actions/configure-pages",
        "actions/create-release",
        "actions/delete-package-versions",
        "actions/deploy-pages",
        "actions/download-artifact",
        "actions/jekyll-build-pages",
        "actions/setup-dotnet",
        "actions/setup-go",
        "actions/setup-java",
        "actions/setup-node",
        "actions/setup-python",
        "actions/stale",
        "actions/starter-workflows",
        "actions/upload-artifact",
        "actions/upload-pages-artifact",
        "actions/upload-release-asset",
        "github/codeql-action",
      ],
      partners: [
        "Alibaba Cloud",
        "Amazon Web Services",
        "Microsoft Azure",
        "Google Cloud",
        "IBM",
        "Red Hat",
        "Tencent Cloud",
        "HashiCorp",
      ],
    };

    const result: WorkflowsCheckResult = await checkWorkflows(
      settings.folders,
      settings.enabledActions,
      settings.partners,
      settings.readOnlyFolders
    );

    console.group(`Compatible workflows (${result.compatibleWorkflows.length})`);
    console.log(result.compatibleWorkflows.map((x) => `${x.folder}/${x.id}`).join("\n"));
    console.groupEnd();

    console.group(`Incompatible workflows (${result.incompatibleWorkflows.length})`);
    console.log(result.incompatibleWorkflows.map((x) => `${x.folder}/${x.id}`).join("\n"));
    console.groupEnd();

    console.log("Switching to GHES branch");
    await exec("git", ["checkout", "ghes"]);

    console.log("Removing modifiable workflows");
    const modifiable = settings.folders.filter(
      (f) => !settings.readOnlyFolders.includes(f)
    );
    await exec("rm", ["-fr", ...modifiable]);
    await exec("rm", ["-fr", "../../icons"]);

    console.log("Restoring read-only folders");
    for (const folder of settings.readOnlyFolders) {
      await exec("git", ["checkout", "main", "--", folder]);
    }

    console.log("Restoring compatible workflows from main");
    const restorePaths: string[] = [];

    for (const wf of result.compatibleWorkflows) {
      if (!settings.readOnlyFolders.includes(wf.folder)) {
        restorePaths.push(join(wf.folder, `${wf.id}.yml`));
        restorePaths.push(
          join(wf.folder, "properties", `${wf.id}.properties.json`)
        );
      }

      if (wf.iconType === "svg" && wf.iconName) {
        restorePaths.push(join("../../icons", `${wf.iconName}.svg`));
      }
    }

    if (restorePaths.length > 0) {
      await exec("git", ["checkout", "main", "--", ...restorePaths]);
    }

    await downgradeArtifactActions(result.compatibleWorkflows, settings.readOnlyFolders);
    await addPlaceholderToAll(result.compatibleWorkflows, settings.readOnlyFolders);

    console.log("Generating .github/CODEOWNERS from JSON");
    await generateCodeowners(
      join(__dirname, "codeowners-config.json"),
      join(__dirname, "..", ".github", "CODEOWNERS")
    );
  } catch (err) {
    console.error("Fatal error", err);
    process.exitCode = 1;
  }
})();