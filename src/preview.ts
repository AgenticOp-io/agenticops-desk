// The first local page address in a dev server's output, colour codes removed.
export function localServerUrl(output: string): string | null {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const hit = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}\/?[^\s"'<>]*/i.exec(plain);
  return hit ? hit[0].replace("0.0.0.0", "localhost").replace(/[.,;)]+$/, "") : null;
}
