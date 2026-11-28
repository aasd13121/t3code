// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A CI-only one-shot; plain Node keeps it dependency-free.
//
// Repairs the two merge conflicts that break the fork's automatic upstream merge
// most often, without a person in the loop:
//
//   agentContextBudget.json  A single-value JSON that records the measured agent
//                            context size. The fork's extra MCP tools always make
//                            it differ from upstream, and it has no merge surface.
//                            The measured values come from running
//                            AgentContextBudget.test.ts, which reports them in its
//                            assertion failure. Both sides disagree, so either
//                            value can be discarded.
//
//   i18n translations/*.json Locale catalogs are flat objects keyed by a hash of
//                            the source string. Both sides add keys in different
//                            places, so a content merge conflicts even though the
//                            union is well defined. Keys are resolved by value:
//                            this script merges the key sets and keeps whichever
//                            side already had a translation for each key.
//
// Usage:
//   node .github/scripts/resolve-fork-merge-conflicts.cjs --list
//       Print the conflicted paths, one per line. Exit 0 when there are none.
//   node .github/scripts/resolve-fork-merge-conflicts.cjs --translate <path>...
//       Resolve the given conflicted catalogs. --translate is passed to the
//       budgets resolver below only for the catalogs it handles.
//   node .github/scripts/resolve-fork-merge-conflicts.cjs --budget <path> <measured-json-file>
//       Write the measured values to the given conflicted budget file.
//   node .github/scripts/resolve-fork-merge-conflicts.cjs --clear-budget <path>
//       Cut a conflicted budget file down to one side so its test can load it.
//   node .github/scripts/resolve-fork-merge-conflicts.cjs --measured <test-output-file>
//       Print the measured values parsed from AgentContextBudget.test.ts's failure.
//   node .github/scripts/resolve-fork-merge-conflicts.cjs --check-catalogs
//       Fail when a resolved locale catalog no longer matches its source catalog.
//
// The caller resolves anything this script cannot: it exits 1 with the remaining
// paths so the workflow can fall back to opening an issue.
const NodeFS = require("node:fs");
const NodePath = require("node:path");

const BUDGET_BASENAME = "agentContextBudget.json";
const CATALOG_PATH = /(^|\/)src\/i18n\/translations\/[^/]+\.json$/;

/** Git reports forward slashes; Windows paths use backslashes. Match either. */
const isCatalogPath = (path) => CATALOG_PATH.test(path.replaceAll("\\", "/"));

const CONFLICT_MARKERS = /^(<{7}|={7}|>{7})( |\r?$)/m;

/** True when the file still holds Git conflict markers. */
function hasConflictMarkers(text) {
  return CONFLICT_MARKERS.test(text);
}

/**
 * Splits a conflicted JSON object body into its two sides.
 *
 * The catalogs and the budget file are flat JSON objects, so every hunk looks
 * like `<<<<<<< ours\n...=======\n...>>>>>>> theirs`. Returns the two parsed
 * objects, or null when the file holds no markers.
 */
function parseConflictedObject(text, label) {
  if (!hasConflictMarkers(text)) return null;
  const sides = { ours: {}, theirs: {} };
  // Every hunk is preceded and followed by ordinary JSON text. Pull the hunks
  // out, then rebuild each side by replacing the other side's hunk with nothing.
  const hunks = [];
  const hunkPattern = /<{7}[^\n]*\r?\n([\s\S]*?)^={7}\r?\n([\s\S]*?)^>{7}[^\n]*\r?\n/gm;
  let oursText = "";
  let theirsText = "";
  let lastIndex = 0;
  let match;
  while ((match = hunkPattern.exec(text)) !== null) {
    oursText += text.slice(lastIndex, match.index) + match[1];
    theirsText += text.slice(lastIndex, match.index) + match[2];
    hunks.push({ ours: match[1], theirs: match[2] });
    lastIndex = hunkPattern.lastIndex;
  }
  oursText += text.slice(lastIndex);
  theirsText += text.slice(lastIndex);
  if (hunks.length === 0) {
    throw new Error(`${label}: conflict markers but no complete hunk`);
  }
  // A hunk that only adds lines leaves one side empty, so that side alone is
  // not valid JSON until the other side is dropped. Each side is rebuilt from
  // every hunk, so both are complete objects.
  sides.ours = JSON.parse(oursText);
  sides.theirs = JSON.parse(theirsText);
  return sides;
}

/**
 * Merges two flat catalogs by key, keeping the fork's order and appending new
 * keys. Sorting would rewrite every line and conflict everywhere next time.
 * A key both sides translated keeps the fork's wording.
 */
function mergeCatalogs(ours, theirs) {
  const merged = {};
  for (const key of Object.keys(ours)) merged[key] = ours[key];
  for (const key of Object.keys(theirs)) {
    if (!(key in merged)) merged[key] = theirs[key];
  }
  return merged;
}

function resolveCatalog(text, label) {
  const sides = parseConflictedObject(text, label);
  if (sides === null) return null;
  return { merged: mergeCatalogs(sides.ours, sides.theirs) };
}

function resolveBudget(text, measured, label) {
  // A `--clear-budget` pass runs first, so this may be either the conflicted file
  // or the one that pass left behind.
  const sides = parseConflictedObject(text, label) ?? {
    ours: JSON.parse(text),
    theirs: {},
  };
  for (const key of Object.keys(measured)) {
    if (!(key in sides.ours) && !(key in sides.theirs)) {
      throw new Error(`${label}: measured key ${key} is in neither side`);
    }
  }
  const merged = {};
  for (const key of Object.keys(sides.ours)) {
    merged[key] = key in measured ? measured[key] : sides.ours[key];
  }
  for (const key of Object.keys(sides.theirs)) {
    if (!(key in merged)) {
      merged[key] = key in measured ? measured[key] : sides.theirs[key];
    }
  }
  return { merged };
}

/** Reads the measured values out of AgentContextBudget.test.ts's failure output. */
function parseMeasuredBudget(output) {
  const report = /T3_AGENT_CONTEXT_BUDGET\s+(\{[^\r\n]+\})/.exec(output);
  if (report !== null) {
    const measured = JSON.parse(report[1]);
    return Object.keys(measured).length > 0 ? measured : null;
  }
  // The assertion prints `actual: { ... }` with the measured numbers.
  const start = output.indexOf("actual: {");
  if (start === -1) return null;
  const bodyStart = output.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < output.length; index += 1) {
    const character = output[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = output.slice(bodyStart + 1, end);
  const measured = {};
  for (const line of body.split("\n")) {
    const entry = /^\s*([A-Za-z0-9_]+):\s*(\d+)\s*,?\s*$/.exec(line);
    if (entry !== null) measured[entry[1]] = Number(entry[2]);
  }
  return Object.keys(measured).length > 0 ? measured : null;
}

function writeJson(file, value) {
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Fails when a locale catalog lost a key the source catalog still has — the one
 * failure a repair can introduce. Extra keys are the fork's own drift, so ignored.
 */
function checkCatalogs(root) {
  const apps = ["apps/web", "apps/mobile"];
  const problems = [];
  for (const app of apps) {
    const configPath = NodePath.join(root, app, "gt.config.json");
    if (!NodeFS.existsSync(configPath)) continue;
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    const directory = NodePath.join(
      NodePath.dirname(configPath),
      NodePath.dirname(config.files.gt.output),
    );
    const source = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, `${config.defaultLocale}.json`), "utf8"),
    );
    for (const locale of config.locales) {
      const localePath = NodePath.join(directory, `${locale}.json`);
      if (!NodeFS.existsSync(localePath)) continue;
      const catalog = JSON.parse(NodeFS.readFileSync(localePath, "utf8"));
      const missing = Object.keys(source).filter((key) => !(key in catalog));
      if (missing.length > 0) {
        problems.push(
          `${localePath}: missing ${missing.length} key(s) of ${config.defaultLocale}.json, e.g. ${missing[0]}`,
        );
      }
    }
  }
  for (const problem of problems) console.error(problem);
  return problems.length === 0;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "--list") {
    const paths = rest;
    for (const path of paths) {
      const text = NodeFS.readFileSync(path, "utf8");
      if (hasConflictMarkers(text)) console.log(path);
    }
    return 0;
  }
  if (mode === "--translate") {
    const unresolved = [];
    for (const path of rest) {
      const label = NodePath.basename(path);
      if (!isCatalogPath(path)) {
        unresolved.push(path);
        continue;
      }
      const text = NodeFS.readFileSync(path, "utf8");
      const result = resolveCatalog(text, label);
      if (result === null) {
        unresolved.push(path);
        continue;
      }
      writeJson(path, result.merged);
    }
    for (const path of unresolved) console.error(`unresolved: ${path}`);
    return unresolved.length === 0 ? 0 : 1;
  }
  if (mode === "--budget") {
    const [path, measuredFile] = rest;
    if (path === undefined || measuredFile === undefined) {
      console.error("usage: --budget <path> <measured-json-file>");
      return 2;
    }
    const measured = JSON.parse(NodeFS.readFileSync(measuredFile, "utf8"));
    const result = resolveBudget(
      NodeFS.readFileSync(path, "utf8"),
      measured,
      NodePath.basename(path),
    );
    if (result === null) {
      console.error(`unresolved: ${path}`);
      return 1;
    }
    writeJson(path, result.merged);
    return 0;
  }
  if (mode === "--clear-budget") {
    // Markers make the file invalid JSON, so the measuring test cannot load it.
    // -1 forces a mismatch: either side's numbers could already be correct, and a
    // passing test prints no measurement for the next step to parse.
    const [path] = rest;
    if (path === undefined) {
      console.error("usage: --clear-budget <path>");
      return 2;
    }
    const sides = parseConflictedObject(NodeFS.readFileSync(path, "utf8"), NodePath.basename(path));
    if (sides === null) {
      console.error(`unresolved: ${path}`);
      return 1;
    }
    const cleared = {};
    for (const key of Object.keys(sides.ours)) cleared[key] = -1;
    for (const key of Object.keys(sides.theirs)) {
      if (!(key in cleared)) cleared[key] = -1;
    }
    writeJson(path, cleared);
    return 0;
  }
  if (mode === "--measured") {
    const [outputFile] = rest;
    if (outputFile === undefined) {
      console.error("usage: --measured <test-output-file>");
      return 2;
    }
    const measured = parseMeasuredBudget(NodeFS.readFileSync(outputFile, "utf8"));
    if (measured === null) {
      console.error("no measured budget found in the test output");
      return 1;
    }
    process.stdout.write(`${JSON.stringify(measured)}\n`);
    return 0;
  }
  if (mode === "--check-catalogs") {
    const [root = process.cwd()] = rest;
    return checkCatalogs(root) ? 0 : 1;
  }
  console.error(
    "usage: resolve-fork-merge-conflicts.cjs --list <path>... | --translate <path>... | --budget <path> <measured> | --clear-budget <path> | --measured <output> | --check-catalogs [root]",
  );
  return 2;
}

module.exports = {
  BUDGET_BASENAME,
  checkCatalogs,
  hasConflictMarkers,
  mergeCatalogs,
  parseConflictedObject,
  parseMeasuredBudget,
  resolveBudget,
  resolveCatalog,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
