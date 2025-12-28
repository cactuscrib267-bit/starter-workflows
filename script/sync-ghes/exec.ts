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

async function loadWorkflowProperties(folder: string, id: string) {
  try {
    return require(join(folder, "properties", `${id}.properties.json`)) as WorkflowProperties;
  } catch {
    return null;
  }
}

async function checkWorkflow(
  workflowPath: string,
  enabledActions: string[]
): Promise<boolean> {
  const enabled = new Set(enabledActions.map((x) => x.toLowerCase()));

  try {
    const content = await fs.readFile(workflowPath, "utf8");
    const workflow = safeLoad(content) as any;

    for (const job of Object.values(workflow.jobs || {})) {
      const steps = (job as any).steps || [];

      for (const step of steps) {
        if (step.uses) {
          const [actionName] = String(step.uses).split("@");
          const actionNwo = actionName.split("/").slice(0, 2).join("/");

          if (!enabled.has(actionNwo.toLowerCase())) {
            console.info(
              `Workflow ${workflowPath} uses '${actionName}' which is not supported for GHES.`
            );
            return false;
          }
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`Error checking workflow ${workflowPath}`, err);
    throw err;
  }
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

  const partnerSet = new Set(partners.map((x) => x.toLowerCase()));
  const readOnlySet = new Set(readOnlyFolders);

  for (const folder of folders) {
    const entries = await fs.readdir(folder, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".yml") continue;

      const id = basename(entry.name, ".yml");
      const workflowPath = join(folder, entry.name);

      const props = await loadWorkflowProperties(folder, id);
      if (!props) continue;

      const isPartner = props.creator
        ? partnerSet.has(props.creator.toLowerCase())
        : false;

      const isReadOnly = readOnlySet.has(folder);
      const isCodeScanning = basename(folder) === "code-scanning";

      const enabled =
        !isPartner &&
        (props.enterprise === true || !isCodeScanning) &&
        (isReadOnly || (await checkWorkflow(workflowPath, enabledActions)));

      const desc: WorkflowDesc = {
        folder,
        id,
        iconName: props.iconName,
        iconType: props.iconName?.startsWith("octicon") ? "octicon" : "svg",
      };

      if (enabled) result.compatibleWorkflows.push(desc);
      else result.incompatibleWorkflows.push(desc);
    }
  }

  return result;
}

async function downgradeArtifactActions(workflows: WorkflowDesc[], readOnly: string[]) {
  console.group("Downgrading artifact actions v4 → v3");

  for (const wf of workflows) {
    if (readOnly.includes(wf.folder)) continue;

    const path = join(wf.folder, `${wf.id}.yml`);
    const content = await fs.readFile(path, "utf8");

    if (!content.includes("@v4")) continue;

    console.log(`Updating ${path}`);

    let updated = content.replace(/actions\/upload-artifact@v4/g, "actions/upload-artifact@v3");
    updated = updated.replace(/actions\/download-artifact@v4/g, "actions/download-artifact@v3");

    await fs.writeFile(path, updated);
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

    const result = await checkWorkflows(
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

    console.log("Restoring compatible workflows");
    const restorePaths: string[] = [];

    for (const wf of result.compatibleWorkflows) {
      if (!settings.readOnlyFolders.includes(wf.folder)) {
        restorePaths.push(join(wf.folder, `${wf.id}.yml`));
        restorePaths.push(join(wf.folder, "properties", `${wf.id}.properties.json`));
      }

      if (wf.iconType === "svg" && wf.iconName) {
        restorePaths.push(join("../../icons", `${wf.iconName}.svg`));
      }
    }

    if (restorePaths.length > 0) {
      await exec("git", ["checkout", "main", "--", ...restorePaths]);
    }

    await downgradeArtifactActions(result.compatibleWorkflows, settings.readOnlyFolders);
  } catch (err) {
    console.error("Fatal error", err);
    process.exitCode = 1;
  }
})();