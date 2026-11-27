const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { canAdvance } = require("./fork-release-guard.cjs");

test("the workflow-capable token is available only during release publication", () => {
  const root = path.resolve(__dirname, "../..");
  const { parse } = createRequire(path.join(root, "apps/server/package.json"))("yaml");
  const workflow = parse(
    fs.readFileSync(path.join(root, ".github/workflows/release-fork.yml"), "utf8"),
  );
  const publication = new Set(["Publish to GitHub Releases", "Update nightly channel pointer"]);
  assert.doesNotMatch(JSON.stringify(workflow.env), /FORK_RELEASE_TOKEN/);
  for (const job of Object.values(workflow.jobs)) {
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /FORK_RELEASE_TOKEN/);
    for (const step of job.steps) {
      if (publication.has(step.name)) {
        assert.equal(step.env.GH_TOKEN, "${{ secrets.FORK_RELEASE_TOKEN }}");
      } else {
        assert.doesNotMatch(JSON.stringify(step), /FORK_RELEASE_TOKEN/);
      }
    }
  }
});

test("an older build finishing last cannot roll back the nightly pointer", () => {
  assert.equal(
    canAdvance("0.1.12-nightly.20261123.5124-tb", "v0.1.14-nightly.20261127.5332-tb"),
    false,
  );
  assert.equal(
    canAdvance("0.1.14-nightly.20261127.5319-tb", "v0.1.14-nightly.20261127.5332-tb"),
    false,
  );
  assert.equal(
    canAdvance("0.1.14-nightly.20261127.5332-tb", "v0.1.14-nightly.20261127.5332-tb.2"),
    false,
  );
});

test("new nightlies, numeric build rollover and retry revisions can advance", () => {
  assert.equal(
    canAdvance("0.1.14-nightly.20261127.5332-tb", "v0.1.14-nightly.20261127.5319-tb"),
    true,
  );
  assert.equal(
    canAdvance("0.1.14-nightly.20261127.10000-tb", "v0.1.14-nightly.20261127.9999-tb"),
    true,
  );
  assert.equal(
    canAdvance("0.1.14-nightly.20261127.5332-tb.10", "v0.1.14-nightly.20261127.5332-tb.9"),
    true,
  );
  assert.equal(
    canAdvance("0.1.14-nightly.20261127.5332-tb", "v0.1.14-nightly.20261127.5332-tb"),
    true,
  );
});

test("malformed channel metadata fails closed", () => {
  assert.throws(() => canAdvance("0.1.14-nightly.20261127.5332-tb", "unknown"));
  assert.throws(() => canAdvance("latest", "0.1.14-nightly.20261127.5332-tb"));
});
