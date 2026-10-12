import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

// The published image (built from the v* tag) used to carry no OCI labels, so
// `docker inspect` could not say which commit or version an image was built from.
test("Dockerfile labels the image with revision, version and source", () => {
  const dockerfile = read("Dockerfile");
  // The production stage declares both build args the labels read.
  const prod = dockerfile.slice(dockerfile.indexOf("AS production"));
  assert.match(prod, /^ARG SOURCE_COMMIT=unknown$/m);
  assert.match(prod, /^ARG APP_VERSION=unknown$/m);
  assert.match(
    prod,
    /org\.opencontainers\.image\.revision="\$\{SOURCE_COMMIT\}"/,
  );
  assert.match(prod, /org\.opencontainers\.image\.version="\$\{APP_VERSION\}"/);
  assert.match(
    prod,
    /org\.opencontainers\.image\.source="https:\/\/github\.com\/[Ss]pooled-[Cc]loud\/spooled-example-spriteforge"/,
  );
  // LABEL comes after both ARGs (an ARG is empty before its declaration).
  assert.ok(prod.indexOf("LABEL ") > prod.indexOf("ARG APP_VERSION"));
});

test("CI passes the commit and version to both image builds and labels both", () => {
  const ci = read(".github/workflows/ci.yml");
  const pushSteps = ci.split("docker/build-push-action@v7").slice(1);
  assert.equal(pushSteps.length, 2, "main build and tag release build");
  for (const step of pushSteps) {
    assert.match(step, /SOURCE_COMMIT=\$\{\{ github\.sha \}\}/);
    assert.match(step, /APP_VERSION=\$\{\{ steps\.[a-z]+\.outputs\.(VERSION|NUMBER) \}\}/);
    assert.match(step, /labels: \$\{\{ steps\.meta\.outputs\.labels \}\}/);
  }
  // Each build has its own metadata step that sets the revision and version labels.
  const metaSteps = ci.split("docker/metadata-action@v6").slice(1);
  assert.equal(metaSteps.length, 2);
  for (const step of metaSteps) {
    assert.match(step, /org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
    assert.match(step, /org\.opencontainers\.image\.version=\$\{\{ steps\.[a-z]+\.outputs\.(VERSION|NUMBER) \}\}/);
  }
  // The tag build's version label is the number (1.0.23), not the tag (v1.0.23).
  assert.match(ci, /echo "NUMBER=\$\{GITHUB_REF#refs\/tags\/v\}" >> \$GITHUB_OUTPUT/);
});

test("package.json and package-lock.json agree on the application version", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});
