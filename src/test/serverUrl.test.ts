// The address the extension connects to when nothing is configured, and that a configured one wins.
// NEO-AG serves on 8000 (config/neoag.toml); the extension used to default to 8720, a port NEO-AG
// had retired, so out of the box it never connected.
import { stubState } from "./vscodeStub";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { serverUrl } from "../chatViewProvider";
import { DEFAULT_SERVER_URL } from "../neoClient";

const saved = stubState.serverUrl;

describe("neo.serverUrl", () => {
  afterEach(() => {
    stubState.serverUrl = saved;
  });

  it("defaults to NEO-AG's port, 8000", () => {
    assert.equal(DEFAULT_SERVER_URL, "http://127.0.0.1:8000");
    stubState.serverUrl = "";                                   // nothing configured
    assert.equal(serverUrl(), "http://127.0.0.1:8000");
  });

  it("is declared in package.json with the same default the code falls back to", () => {
    // out/test/ -> the package root, where package.json is.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    const declared = manifest.contributes.configuration.properties["neo.serverUrl"].default;
    assert.equal(declared, DEFAULT_SERVER_URL);
  });

  it("keeps a server URL the user configured, trailing slashes aside", () => {
    stubState.serverUrl = "http://10.0.0.5:8720/";
    assert.equal(serverUrl(), "http://10.0.0.5:8720");
  });
});
