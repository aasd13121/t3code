const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const { parse } = createRequire(path.join(root, "apps/server/package.json"))("yaml");
const workflow = parse(
  fs.readFileSync(path.join(root, ".github/workflows/follow-upstream.yml"), "utf8"),
);
const steps = workflow.jobs.follow.steps;
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const bash =
  os.platform() === "win32"
    ? path.resolve(git(root, "--exec-path"), "../../..", "bin/bash.exe")
    : "bash";

test("the sync push uses a repository SSH credential without persisting it during dependency installation", () => {
  const checkout = steps.find((step) => step.name === "Checkout fork (full history)");
  assert.equal(checkout.with["persist-credentials"], true);
  assert.equal(workflow.permissions.contents, "read");
  assert.ok(
    steps.findIndex((step) => step.name === "Clear checkout credential before project code") <
      steps.findIndex((step) => step.name === "Setup dependencies for the repair"),
  );
  assert.match(checkout.with["sparse-checkout"], /!\/\.repos\//);
  assert.equal(checkout.with["sparse-checkout-cone-mode"], false);
  assert.equal(checkout.with["ssh-key"], undefined);
  const push = steps.find((step) => step.name === "Push merged task-board");
  assert.equal(push.env.SYNC_SSH_KEY, "${{ secrets.UPSTREAM_SYNC_SSH_KEY }}");
  assert.match(
    push.run,
    /git push "git@github.com:\$GITHUB_REPOSITORY.git" HEAD:refs\/heads\/task-board/,
  );
  assert.match(push.run, /trap .* EXIT/);
  assert.match(push.run, /StrictHostKeyChecking=yes/);
  const install = steps.find((step) => step.name === "Setup dependencies for the repair");
  assert.match(install.with["install-args"], /--filter=t3\.\.\./);
});

test("dry-run validation cannot push or publish", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.type, "boolean");
  for (const name of ["Push merged task-board", "Dispatch release-fork workflow"]) {
    assert.match(steps.find((step) => step.name === name).if, /inputs\.dry_run != true/);
  }
});

test("the actual tag resolver rejects an old tag before publishing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-upstream-tag-"));
  try {
    const output = path.join(directory, "output").replaceAll("\\", "/");
    fs.writeFileSync(output, "");
    const result = spawnSync(
      bash,
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        "git() { printf '%s\\n' 'hash refs/tags/v0.1.14-nightly.20261127.5332'; };\n" +
          steps.find((step) => step.name === "Resolve latest upstream nightly tag").run,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INPUT_TAG: "v0.1.12-nightly.20261123.5124",
          DRY_RUN: "false",
          GITHUB_OUTPUT: output,
        },
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Only the latest upstream nightly/);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const conflict of [false, true]) {
  test(`the actual merge step ${conflict ? "keeps unsupported conflicts for manual repair" : "commits upstream workflow updates"}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-upstream-merge-"));
    try {
      git(directory, "init", "--quiet", "--initial-branch=task-board");
      git(directory, "config", "core.autocrlf", "false");
      git(directory, "config", "user.name", "Sync test");
      git(directory, "config", "user.email", "sync@example.test");
      fs.mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
      fs.writeFileSync(path.join(directory, ".github/workflows/ci.yml"), "name: base\n");
      fs.writeFileSync(path.join(directory, "app.txt"), "base\n");
      git(directory, "add", ".");
      git(directory, "commit", "--quiet", "-m", "base");
      git(directory, "checkout", "--quiet", "-b", "upstream");
      fs.writeFileSync(path.join(directory, ".github/workflows/ci.yml"), "name: upstream\n");
      if (conflict) fs.writeFileSync(path.join(directory, "app.txt"), "upstream change\n");
      git(directory, "add", ".");
      git(directory, "commit", "--quiet", "-m", "upstream update");
      git(directory, "checkout", "--quiet", "task-board");
      fs.writeFileSync(path.join(directory, conflict ? "app.txt" : "fork.txt"), "fork change\n");
      git(directory, "add", ".");
      git(directory, "commit", "--quiet", "-m", "fork feature");
      const envFile = path.join(directory, "github-env");
      fs.writeFileSync(envFile, "");
      const result = spawnSync(
        bash,
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          steps.find((step) => step.name === "Merge upstream nightly into task-board").run,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            UPSTREAM_TAG: "upstream",
            GITHUB_ENV: envFile.replaceAll("\\", "/"),
          },
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(
        fs.readFileSync(path.join(directory, ".github/workflows/ci.yml"), "utf8"),
        "name: upstream\n",
      );
      if (conflict) {
        assert.match(fs.readFileSync(envFile, "utf8"), /merge_conflict=true/);
        assert.equal(git(directory, "diff", "--name-only", "--diff-filter=U"), "app.txt");
      } else {
        assert.equal(git(directory, "status", "--porcelain", "--untracked-files=no"), "");
        assert.equal(git(directory, "show", "-s", "--format=%P", "HEAD").split(" ").length, 2);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
