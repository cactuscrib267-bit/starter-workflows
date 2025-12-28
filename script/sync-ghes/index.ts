#!/usr/bin/env npx ts-node
import { promises as fs } from "fs";
import { safeLoad } from "js-yaml";
import { basename, extname, join } from "path";
import { exec } from "./exec";

interface WorkflowDesc {
  folder: string;
  id: string;
  iconName?: string;
  iconType?: "svg" | "octicon";
}

interface WorkflowProperties {
  name: string;
  description: string;
  iconName?: string;
  categories: string[] | null;
  creator?: string;
  enterprise?: boolean;
}

interface WorkflowsCheckResult {
  compatibleWorkflows: WorkflowDesc[];
  incompatibleWorkflows: WorkflowDesc[];
}

async function checkWorkflows(
  folders: string[],
  enabledActions: string[],
  partners: string[],
  readOnlyFolders: string[]
): Promise<WorkflowsCheckResult> {
  const result: WorkflowsCheckResult = {
    compatibleWorkflows: [],
    incompatibleWorkflows: [],
  };
  const partnersSet = new Set(partners.map((x) => x.toLowerCase()));
  const readOnlySet = new Set(readOnlyFolders);

  for (const folder of folders) {
    const dir = await fs.readdir(folder, { withFileTypes: true });

    for (const e of dir) {
      if (e.isFile() && extname(e.name) === ".yml") {
        const workflowFilePath = join(folder, e.name);
        const workflowId = basename(e.name, extname(e.name));

        let workflowProperties: WorkflowProperties;
        try {
          workflowProperties = require(join(folder, "properties", `${workflowId}.properties.json`));
        } catch {
          // Skip workflows without properties file
          continue;
        }

        const iconName: string | undefined = workflowProperties.iconName;

        const isPartnerWorkflow = workflowProperties.creator
          ? partnersSet.has(workflowProperties.creator.toLowerCase())
          : false;

        const isReadOnlyFolder = readOnlySet.has(folder);
        const isCodeScanningFolder = basename(folder) === "code-scanning";

        const enabled =
          !isPartnerWorkflow &&
          (workflowProperties.enterprise === true || !isCodeScanningFolder) &&
          (isReadOnlyFolder || (await checkWorkflow(workflowFilePath, enabledActions)));

        const workflowDesc: WorkflowDesc = {
          folder,
          id: workflowId,
          iconName,
          iconType: iconName && iconName.startsWith("octicon") ? "octicon" : "svg",
        };

        if (!enabled) {
          result.incompatibleWorkflows.push(workflowDesc);
        } else {
          result.compatibleWorkflows.push(workflowDesc);
        }
      }
    }
  }

  return result;
}

async function checkWorkflow(
  workflowPath: string,
  enabledActions: string[]
): Promise<boolean> {
  const enabledActionsSet = new Set(enabledActions.map((x) => x.toLowerCase()));

  try {
    const workflowFileContent = await fs.readFile(workflowPath, "utf8");
    const workflow = safeLoad(workflowFileContent);

    for (const job of Object.values(workflow.jobs || {})) {
      for (const step of job.steps || []) {
        if (step.uses) {
          const [actionName] = step.uses.split("@");
          const actionNwo = actionName.split("/").slice(0, 2).join("/");
          if (!enabledActionsSet.has(actionNwo.toLowerCase())) {
            console.info(
              `Workflow \( {workflowPath} uses ' \){actionName}' which is not supported for GHES.`
            );
            return false;
          }
        }
      }
    }
    return true;
  } catch (e) {
    console.error("Error while checking workflow", e);
    throw e;
  }
}

(async function main() {
  try {
    // Hard-coded settings based on the provided configuration
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

    const result = await checkWorkflows(
      settings.folders,
      settings.enabledActions,
      settings.partners,
      settings.readOnlyFolders
    );

    console.group(
      `Found ${result.compatibleWorkflows.length} starter workflows compatible with GHES:`
    );
    console.log(
      result.compatibleWorkflows.map((x) => `\( {x.folder}/ \){x.id}`).join("\n")
    );
    console.groupEnd();

    console.group(
      `Ignored ${result.incompatibleWorkflows.length} starter-workflows incompatible with GHES:`
    );
    console.log(
      result.incompatibleWorkflows.map((x) => `\( {x.folder}/ \){x.id}`).join("\n")
    );
    console.groupEnd();

    console.log("Switch to GHES branch");
    await exec("git", ["checkout", "ghes"]);

    console.log("Remove all modifiable workflows");
    const modifiableFolders = settings.folders.filter((f) => !settings.readOnlyFolders.includes(f));
    await exec("rm", ["-fr", ...modifiableFolders]);
    await exec("rm", ["-fr", "../../icons"]);

    console.log("Restore read-only folders");
    for (const folder of settings.readOnlyFolders) {
      await exec("git", ["checkout", "main", "--", folder]);
    }

    console.log("Sync compatible workflows from main branch");
    const pathsToRestore: string[] = [];
    for (const workflow of result.compatibleWorkflows) {
      if (!settings.readOnlyFolders.includes(workflow.folder)) {
        pathsToRestore.push(join(workflow.folder, `${workflow.id}.yml`));
        pathsToRestore.push(join(workflow.folder, "properties", `${workflow.id}.properties.json`));
      }

      if (workflow.iconType === "svg" && workflow.iconName) {
        pathsToRestore.push(join("../../icons", `${workflow.iconName}.svg`));
      }
    }

    if (pathsToRestore.length > 0) {
      await exec("git", ["checkout", "main", "--", ...pathsToRestore]);
    }

    console.group("Downgrade artifact actions from v4 to v3 in compatible workflows");
    for (const workflow of result.compatibleWorkflows) {
      if (settings.readOnlyFolders.includes(workflow.folder)) {
        continue; // Do not modify read-only workflows
      }

      const path = join(workflow.folder, `${workflow.id}.yml`);
      const contents = await fs.readFile(path, "utf8");

      if (contents.includes("actions/upload-artifact@v4") || contents.includes("actions/download-artifact@v4")) {
        console.log(`Updating ${path} to use v3 artifact actions`);
        let updatedContents = contents.replace(/actions\/upload-artifact@v4/g, "actions/upload-artifact@v3");
        updatedContents = updatedContents.replace(/actions\/download-artifact@v4/g, "actions/download-artifact@v3");
        await fs.writeFile(path, updatedContents);
      }
    }
    console.groupEnd();

  } catch (e) {
    console.error("Unhandled error while syncing workflows", e);
    process.exitCode = 1;
  }
})();