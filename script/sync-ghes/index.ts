import { promises as fs } from "fs";
import { join } from "path";
import { CodeOwnersConfig } from "./codeowners-types";

export async function generateCodeowners(
  configPath: string,
  outputPath: string
) {
  const json = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(json) as CodeOwnersConfig;

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