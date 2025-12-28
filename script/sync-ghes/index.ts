import { promises as fs } from "fs";
import { join, basename, extname } from "path";
import { safeLoad, safeDump } from "js-yaml";

/* ───────── 2) CODEOWNERS types + generator ───────── */

export interface CodeOwnerRule {
  pattern: string;
  teams: string[];
}

export interface CodeOwnersConfig {
  owners: CodeOwnerRule[];
}

export async function generateCodeownersFromConfig(
  config: CodeOwnersConfig,
  outputPath: string
) {
  const lines: string[] = [];

  lines.push("# Auto-generated CODEOWNERS. Do not edit manually.");
  lines.push("");

  for (const rule of config.owners) {
    const teams = rule.teams.join(" ");
    lines.push(`${rule.pattern} ${teams}`);
  }

  lines.push("");

  await fs.mkdir(join(outputPath, ".."), { recursive: true });
  await fs.writeFile(outputPath, lines.join("\n"), "utf8");
}

/* ───────── 3) Workflow rewrite + transforms ───────── */

export async function rewriteWorkflow(
  path: string,
  transform: (wf: any) => any
) {
  const content = await fs.readFile(path, "utf8");
  const workflow = safeLoad(content);

  const updated = transform(workflow);

  const yaml = safeDump(updated, {
    lineWidth: -1,
    noRefs: true,
  });

  await fs.writeFile(path, yaml, "utf8");
}

export function addPlaceholderStep(workflow: any) {
  if (!workflow.jobs) return workflow;

  for (const jobName of Object.keys(workflow.jobs)) {
    const job = workflow.jobs[jobName] || {};
    const steps = job.steps || [];

    steps.push({
      name: "Custom placeholder step",
      run: "# TODO: add commands here",
    });

    job.steps = steps;
    workflow.jobs[jobName] = job;
  }

  return workflow;
}

/* ───────── 4) Workflow check logic ───────── */

export interface WorkflowDesc {
  folder: string;
  id: string;
  iconName?: string;
  iconType?: "svg" | "octicon";
}

export interface WorkflowProperties {
  name: string;
  description: string;
  iconName?: string;
  categories: string[] | null;
  creator?: string;
  enterprise?: boolean;
}

export interface WorkflowsCheckResult {
  compatibleWorkflows: WorkflowDesc[];
  incompatibleWorkflows: WorkflowDesc[];
}

async function loadWorkflowProperties(
  folder: string,
  id: string
): Promise<WorkflowProperties | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(join(folder, "properties", `${id}.properties.json`));
  } catch {
    return null;
  }
}

export async function checkWorkflow(
  workflowPath: string,
  enabledActions: string[]
): Promise<boolean> {
  const enabled = new Set(enabledActions.map((x) => x.toLowerCase()));

  const content = await fs.readFile(workflowPath, "utf8");
  const workflow = safeLoad(content) as any;

  for (const job of Object.values(workflow.jobs || {})) {
    const j: any = job;
    for (const step of j.steps || []) {
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
}

export async function checkWorkflows(
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