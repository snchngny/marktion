import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "markra-release-assets-"));
}

function writeFile(filePath, content = "asset") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runNormalizeScript(rootDir, env) {
  return spawnSync(process.execPath, ["scripts/release/normalize-release-artifacts.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      APP_PRODUCT_NAME: "Markra",
      APP_SLUG: "markra",
      DESKTOP_DIR: path.join(rootDir, "apps", "desktop"),
      RELEASE_VERSION: "0.0.8",
      ...env,
    },
  });
}

function readZipEntries(archive) {
  const entries = new Map();
  let offset = 0;

  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compression = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = archive.subarray(dataStart, dataEnd);
    const data = compression === 8 ? zlib.inflateRawSync(compressed) : compressed;

    entries.set(name, data);
    offset = dataEnd;
  }

  return entries;
}

test("normalize-release-artifacts adds macOS platform labels to updater and dmg assets", () => {
  const rootDir = makeTempDir();
  const bundleRoot = path.join(
    rootDir,
    "apps",
    "desktop",
    "src-tauri",
    "target",
    "x86_64-apple-darwin",
    "release",
    "bundle",
  );
  const oldUpdater = path.join(bundleRoot, "macos", "markra_0.0.8_x64.app.tar.gz");
  const oldDmg = path.join(bundleRoot, "dmg", "Markra_0.0.8_x64.dmg");

  writeFile(oldUpdater);
  writeFile(`${oldUpdater}.sig`, "signature");
  writeFile(oldDmg);

  const result = runNormalizeScript(rootDir, {
    ASSET_ARCH: "x64",
    ASSET_PLATFORM: "macos",
    TARGET: "x86_64-apple-darwin",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(oldUpdater), false);
  assert.equal(fs.existsSync(`${oldUpdater}.sig`), false);
  assert.equal(fs.existsSync(oldDmg), false);
  assert.equal(fs.existsSync(path.join(bundleRoot, "macos", "Markra_0.0.8_macos_x64_updater.app.tar.gz")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "macos", "Markra_0.0.8_macos_x64_updater.app.tar.gz.sig")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "dmg", "Markra_0.0.8_macos_x64.dmg")), true);
});

test("normalize-release-artifacts adds Windows platform labels and creates a portable zip", () => {
  const rootDir = makeTempDir();
  const releaseRoot = path.join(
    rootDir,
    "apps",
    "desktop",
    "src-tauri",
    "target",
    "x86_64-pc-windows-msvc",
    "release",
  );
  const bundleRoot = path.join(releaseRoot, "bundle");
  const oldSetup = path.join(bundleRoot, "nsis", "Markra_0.0.8_x64-setup.exe");
  const oldMsi = path.join(bundleRoot, "msi", "Markra_0.0.8_x64_en-US.msi");
  const portableZip = path.join(bundleRoot, "portable", "Markra_0.0.8_windows_x64_portable.zip");

  writeFile(path.join(releaseRoot, "markra.exe"), "portable-binary");
  writeFile(path.join(releaseRoot, "support.dll"), "portable-library");
  writeFile(oldSetup);
  writeFile(`${oldSetup}.sig`, "setup-signature");
  writeFile(oldMsi);
  writeFile(`${oldMsi}.sig`, "msi-signature");

  const result = runNormalizeScript(rootDir, {
    ASSET_ARCH: "x64",
    ASSET_PLATFORM: "windows",
    TARGET: "x86_64-pc-windows-msvc",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(oldSetup), false);
  assert.equal(fs.existsSync(`${oldSetup}.sig`), false);
  assert.equal(fs.existsSync(oldMsi), false);
  assert.equal(fs.existsSync(`${oldMsi}.sig`), false);
  assert.equal(fs.existsSync(path.join(bundleRoot, "nsis", "Markra_0.0.8_windows_x64_setup.exe")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "nsis", "Markra_0.0.8_windows_x64_setup.exe.sig")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "msi", "Markra_0.0.8_windows_x64_en-US.msi")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "msi", "Markra_0.0.8_windows_x64_en-US.msi.sig")), true);
  assert.equal(fs.existsSync(portableZip), true);

  const zipContents = fs.readFileSync(portableZip);
  const zipEntries = readZipEntries(zipContents);
  assert.equal(zipContents.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  assert.match(zipContents.toString("latin1"), /Markra\/Markra\.exe/);
  assert.match(zipContents.toString("latin1"), /Markra\/support\.dll/);
  assert.match(zipContents.toString("latin1"), /Markra\/markra-portable\.json/);
  assert.deepEqual(JSON.parse(zipEntries.get("Markra/markra-portable.json").toString("utf8")), {
    executable: "Markra.exe",
    files: ["Markra.exe", "support.dll", "markra-portable.json"],
    formatVersion: 1,
  });
});

test("normalize-release-artifacts adds Linux platform labels to package assets", () => {
  const rootDir = makeTempDir();
  const bundleRoot = path.join(
    rootDir,
    "apps",
    "desktop",
    "src-tauri",
    "target",
    "x86_64-unknown-linux-gnu",
    "release",
    "bundle",
  );
  const oldAppImage = path.join(bundleRoot, "appimage", "Markra_0.0.8_amd64.AppImage");
  const oldDeb = path.join(bundleRoot, "deb", "Markra_0.0.8_amd64.deb");
  const oldRpm = path.join(bundleRoot, "rpm", "Markra-0.0.8-1.x86_64.rpm");

  writeFile(oldAppImage);
  writeFile(`${oldAppImage}.sig`, "appimage-signature");
  writeFile(oldDeb);
  writeFile(`${oldDeb}.sig`, "deb-signature");
  writeFile(oldRpm);
  writeFile(`${oldRpm}.sig`, "rpm-signature");

  const result = runNormalizeScript(rootDir, {
    ASSET_ARCH: "x64",
    ASSET_PLATFORM: "linux",
    TARGET: "x86_64-unknown-linux-gnu",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(bundleRoot, "appimage", "Markra_0.0.8_linux_x64.AppImage")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "appimage", "Markra_0.0.8_linux_x64.AppImage.sig")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "deb", "Markra_0.0.8_linux_x64.deb")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "deb", "Markra_0.0.8_linux_x64.deb.sig")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "rpm", "Markra_0.0.8_linux_x64.rpm")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "rpm", "Markra_0.0.8_linux_x64.rpm.sig")), true);
});
