const assert = require("node:assert/strict");
const NodeFS = require("node:fs");
const NodeOS = require("node:os");
const NodePath = require("node:path");
const test = require("node:test");

const {
  checkCatalogs,
  hasConflictMarkers,
  mergeCatalogs,
  parseConflictedObject,
  parseMeasuredBudget,
  resolveBudget,
  resolveCatalog,
} = require("./resolve-fork-merge-conflicts.cjs");

// The shapes below are the ones the fork's real merges produced: a locale catalog
// where both sides appended keys, and the budget file where both values differ.
const catalogConflict = `{
  "aaaa": "shared key, untouched",
  "bbbb": "fork-only translation",
<<<<<<< HEAD
  "cccc": "fork added this",
  "dddd": "fork added that"
=======
  "cccc": "upstream added this differently",
  "eeee": "upstream added this"
>>>>>>> v0.1.12-nightly.20261123.5124
}
`;

const budgetConflict = `{
<<<<<<< HEAD
  "claudeSystemAppendBytes": 8004,
  "codexAdditionalContextBytes": 9396,
  "mcpToolListJsonBytes": 64543
=======
  "claudeSystemAppendBytes": 6245,
  "codexAdditionalContextBytes": 7639,
  "mcpToolListJsonBytes": 61724
>>>>>>> v0.1.12-nightly.20261123.5124
}
`;

test("hasConflictMarkers distinguishes a resolved file", () => {
  assert.equal(hasConflictMarkers(catalogConflict), true);
  assert.equal(hasConflictMarkers('{\n  "aaaa": "done"\n}\n'), false);
  // A marker inside a string value is not a conflict marker.
  assert.equal(hasConflictMarkers('{\n  "a": "x ======= y"\n}\n'), false);
});

test("parseConflictedObject returns both complete sides", () => {
  const sides = parseConflictedObject(budgetConflict, "budget");
  assert.deepEqual(sides.ours, {
    claudeSystemAppendBytes: 8004,
    codexAdditionalContextBytes: 9396,
    mcpToolListJsonBytes: 64543,
  });
  assert.deepEqual(sides.theirs, {
    claudeSystemAppendBytes: 6245,
    codexAdditionalContextBytes: 7639,
    mcpToolListJsonBytes: 61724,
  });
});

test("parseConflictedObject handles a hunk that only adds lines", () => {
  // This is the shape the real zh.json merge produced: ours had extra keys, theirs
  // was empty in that hunk.
  const text = `{
  "aaaa": "a",
<<<<<<< HEAD
  "bbbb": "b",
  "cccc": "c",
=======
>>>>>>> v0.1.12-nightly.20261123.5124
  "dddd": "d"
}
`;
  const sides = parseConflictedObject(text, "catalog");
  assert.deepEqual(sides.ours, { aaaa: "a", bbbb: "b", cccc: "c", dddd: "d" });
  assert.deepEqual(sides.theirs, { aaaa: "a", dddd: "d" });
});

test("parseConflictedObject returns null without markers", () => {
  assert.equal(parseConflictedObject('{\n  "aaaa": "a"\n}\n', "x"), null);
});

test("mergeCatalogs keeps every key and prefers the fork wording", () => {
  const merged = mergeCatalogs(
    { aaaa: "a", cccc: "fork", dddd: "fork" },
    { aaaa: "a", cccc: "upstream", eeee: "upstream" },
  );
  assert.deepEqual(merged, {
    aaaa: "a",
    cccc: "fork",
    dddd: "fork",
    eeee: "upstream",
  });
});

test("mergeCatalogs keeps the fork's key order and appends new keys", () => {
  // Sorting would rewrite every line and make the next merge conflict everywhere.
  const merged = mergeCatalogs({ b: "2", a: "1" }, { c: "3", b: "2" });
  assert.deepEqual(Object.keys(merged), ["b", "a", "c"]);
});

test("resolveCatalog resolves a real conflict", () => {
  const result = resolveCatalog(catalogConflict, "zh.json");
  assert.deepEqual(result.merged, {
    aaaa: "shared key, untouched",
    bbbb: "fork-only translation",
    cccc: "fork added this",
    dddd: "fork added that",
    eeee: "upstream added this",
  });
});

test("resolveBudget takes the measured values over both sides", () => {
  const measured = {
    claudeSystemAppendBytes: 8004,
    codexAdditionalContextBytes: 9396,
    mcpToolListJsonBytes: 67097,
  };
  const result = resolveBudget(budgetConflict, measured, "agentContextBudget.json");
  assert.deepEqual(result.merged, measured);
});

test("resolveBudget also accepts an already-cleared file", () => {
  // The repair clears the file before measuring, so this is the second pass's input.
  const cleared =
    '{\n  "claudeSystemAppendBytes": -1,\n  "codexAdditionalContextBytes": -1,\n  "mcpToolListJsonBytes": -1\n}\n';
  const measured = {
    claudeSystemAppendBytes: 8004,
    codexAdditionalContextBytes: 9396,
    mcpToolListJsonBytes: 67097,
  };
  assert.deepEqual(resolveBudget(cleared, measured, "agentContextBudget.json").merged, measured);
});

test("resolveBudget rejects a measured value the file never declares", () => {
  assert.throws(
    () => resolveBudget(budgetConflict, { unknownKey: 1 }, "agentContextBudget.json"),
    /unknownKey is in neither side/,
  );
});

test("parseMeasuredBudget reads the assertion output the test prints", () => {
  const output = `FAIL src/provider/AgentContextBudget.test.ts > agent context matches the committed budget
AssertionError: Set agentContextBudget.json to the measured values.: expected {} to deeply equal {}
  actual: {
    claudeSystemAppendBytes: 8004,
    codexAdditionalContextBytes: 9396,
    mcpToolListJsonBytes: 67097
  },
  expected: {
    claudeSystemAppendBytes: 8004,
    codexAdditionalContextBytes: 9396,
    mcpToolListJsonBytes: 64543
  },
`;
  assert.deepEqual(parseMeasuredBudget(output), {
    claudeSystemAppendBytes: 8004,
    codexAdditionalContextBytes: 9396,
    mcpToolListJsonBytes: 67097,
  });
});

test("parseMeasuredBudget ignores a passing run", () => {
  assert.equal(parseMeasuredBudget("Test Files  1 passed (1)\n"), null);
});

test("the CLI resolves files in place", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "resolve-fork-"));
  try {
    // --translate only accepts the catalogs' real location, so mirror it.
    const catalogDirectory = NodePath.join(directory, "apps", "web", "src", "i18n", "translations");
    NodeFS.mkdirSync(catalogDirectory, { recursive: true });
    const catalog = NodePath.join(catalogDirectory, "zh.json");
    const budget = NodePath.join(directory, "agentContextBudget.json");
    const measured = NodePath.join(directory, "measured.json");
    NodeFS.writeFileSync(catalog, catalogConflict);
    NodeFS.writeFileSync(budget, budgetConflict);
    NodeFS.writeFileSync(
      measured,
      JSON.stringify({
        claudeSystemAppendBytes: 8004,
        codexAdditionalContextBytes: 9396,
        mcpToolListJsonBytes: 67097,
      }),
    );

    const { execFileSync } = require("node:child_process");
    const script = NodePath.join(__dirname, "resolve-fork-merge-conflicts.cjs");
    execFileSync(process.execPath, [script, "--translate", catalog]);
    // The budget goes through the same three passes the workflow runs.
    execFileSync(process.execPath, [script, "--clear-budget", budget]);
    execFileSync(process.execPath, [script, "--budget", budget, measured]);

    assert.equal(hasConflictMarkers(NodeFS.readFileSync(catalog, "utf8")), false);
    assert.equal(hasConflictMarkers(NodeFS.readFileSync(budget, "utf8")), false);
    assert.equal(JSON.parse(NodeFS.readFileSync(budget, "utf8")).mcpToolListJsonBytes, 67097);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

test("--clear-budget leaves values that cannot accidentally match", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "clear-budget-"));
  try {
    const budget = NodePath.join(directory, "agentContextBudget.json");
    // "Ours" already holds the true value; keeping either side would let the test
    // pass and print no measurement, which would strand the repair.
    NodeFS.writeFileSync(
      budget,
      '{\n<<<<<<< HEAD\n  "mcpToolListJsonBytes": 67097\n=======\n  "mcpToolListJsonBytes": 61724\n>>>>>>> upstream\n}\n',
    );
    const { execFileSync } = require("node:child_process");
    const script = NodePath.join(__dirname, "resolve-fork-merge-conflicts.cjs");
    execFileSync(process.execPath, [script, "--clear-budget", budget]);
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(budget, "utf8")), { mcpToolListJsonBytes: -1 });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

test("--check-catalogs ignores extra keys but catches a dropped one", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-catalogs-"));
  try {
    const translations = NodePath.join(directory, "apps", "web", "src", "i18n", "translations");
    NodeFS.mkdirSync(translations, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(directory, "apps", "web", "gt.config.json"),
      JSON.stringify({
        defaultLocale: "en",
        locales: ["zh"],
        files: { gt: { output: "src/i18n/translations/[locale].json" } },
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(translations, "en.json"),
      JSON.stringify({ a: "A", b: "B" }),
    );
    // An extra key is the fork's own drift and must not fail the check.
    NodeFS.writeFileSync(
      NodePath.join(translations, "zh.json"),
      JSON.stringify({ a: "甲", b: "乙", fork: "叉" }),
    );
    assert.equal(checkCatalogs(directory), true);

    NodeFS.writeFileSync(NodePath.join(translations, "zh.json"), JSON.stringify({ a: "甲" }));
    assert.equal(checkCatalogs(directory), false);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
