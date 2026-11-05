// The packaged app starts here and hands over to the installed code or to a patch folder.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { chooseBoot, rollback } from "./choice.mjs";

const root = app.getAppPath();
const installed = app.getVersion();
const stateFile = path.join(root, "patches", "current.json");

function read() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function save(state) {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
  renameSync(`${stateFile}.tmp`, stateFile);
}

function start(version) {
  app.setVersion(version ?? installed);
  const folder = version ? path.join(root, "patches", version) : root;
  return import(pathToFileURL(path.join(folder, "dist-electron", "main.js")).href);
}

const { run, state } = chooseBoot(read());
if (state) save(state);
try {
  await start(run);
} catch (err) {
  if (!run) throw err;
  console.error(`AgenticOps Desk patch ${run} did not load`, err);
  const back = rollback(read());
  save(back);
  await start(back.version);
}
