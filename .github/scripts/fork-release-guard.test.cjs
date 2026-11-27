const assert = require("node:assert/strict");
const test = require("node:test");
const { canAdvance } = require("./fork-release-guard.cjs");

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
