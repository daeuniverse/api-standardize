import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createContract } from "./contract.mjs";
import { validateFlowTrace } from "./validate-flow.mjs";

const OPENAPI_FILE = new URL("../source/openapi.yaml", import.meta.url);

function validateConfigExample(example) {
  const errors = [];
  const body = example.body;
  const diagnostics = body.diagnostics ?? body.error?.details?.diagnostics ?? [];
  if (example.operationId === "getConfig" || example.kind === "request") {
    const ids = new Set();
    for (const [index, source] of body.sources.entries()) {
      const id = source.id ?? `source-${index + 1}`;
      if (ids.has(id)) errors.push(`duplicate source ID ${id}`);
      ids.add(id);
    }
    for (const diagnostic of body.diagnostics ?? []) {
      if (!ids.has(diagnostic.source_id)) errors.push(`unknown diagnostic source ${diagnostic.source_id}`);
    }
  }
  for (const diagnostic of diagnostics) {
    const span = diagnostic.span;
    if (span === null) continue;
    if (span.end_line < span.start_line ||
        (span.end_line === span.start_line && span.end_column < span.start_column)) {
      errors.push("diagnostic span ends before its start");
    }
    if ((diagnostic.line !== null && diagnostic.line !== span.start_line) ||
        (diagnostic.column !== null && diagnostic.column !== span.start_column)) {
      errors.push("diagnostic location differs from its span start");
    }
  }
  return errors;
}

export function checkContract(spec) {
  const context = createContract(spec);
  const errors = [...context.errors];
  let flowCount = 0;
  for (const example of context.examples.values()) {
    if (context.errors.length === 0 &&
        ((example.operationId === "getConfig" && example.status === 200) ||
         (example.operationId === "validateConfig" && (example.kind === "request" || example.status === 200)) ||
         ((example.operationId === "replaceConfigSource" || example.operationId === "createConfigSource") && example.status === 422))) {
      for (const error of validateConfigExample(example)) errors.push(`${example.id}: ${error}`);
    }
    if (example.kind !== "response" || example.operationId !== "getFlow" || example.status !== 200) continue;
    flowCount += 1;
    for (const error of validateFlowTrace(example.body)) errors.push(`${example.id}: ${error}`);
  }
  return { context, examples: context.examples, errors, flowCount };
}

export async function main() {
  let spec;
  try {
    spec = parse(await readFile(OPENAPI_FILE, "utf8"));
  } catch (error) {
    console.error(`Contract check failed: source/openapi.yaml: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = checkContract(spec);
  if (result.errors.length > 0) {
    console.error(`Contract check failed with ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}:`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Contract OK: ${result.examples.size} examples, ${result.flowCount} flow traces, ${Object.keys(spec.components?.schemas ?? {}).length} schemas, ${Object.keys(spec.paths ?? {}).length} paths.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
