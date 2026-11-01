import path from "node:path";

// Claude Code names a project folder by turning every character that is not a letter or digit into "-".
export function encodeProjectPath(p: string) {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

// The memory folder Claude Code already reads: ~/.claude/projects/<encoded-cwd>/memory.
// The drive letter is stored lowercase. An existing folder wins over the lowercase-drive guess.
export function claudeMemoryDir(workspace: string, home: string, exists: (dir: string) => boolean): string {
  const resolved = path.resolve(workspace);
  const projects = path.join(home, ".claude", "projects");
  const driveLower = resolved.replace(/^([A-Za-z]):/, (_, drive: string) => drive.toLowerCase());
  const names = [encodeProjectPath(driveLower), encodeProjectPath(resolved)];
  for (const name of names) {
    if (exists(path.join(projects, name))) return path.join(projects, name, "memory");
  }
  return path.join(projects, names[0], "memory");
}
