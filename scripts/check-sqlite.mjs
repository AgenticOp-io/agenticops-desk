console.log("node", process.versions.node, "electron", process.versions.electron);
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(`${process.env.APPDATA}/Cursor/User/globalStorage/state.vscdb`, { readOnly: true });
  console.log("ok", db.prepare("select count(*) n from composerHeaders").get());
  db.close();
} catch (e) {
  console.log("ERR", e.message);
}
