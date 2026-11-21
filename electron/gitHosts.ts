// No Node imports: the Code window builds these links too.
export type RemoteHost = { kind: "github" | "gitlab" | "bitbucket" | "azure" | "other"; web: string; name: string };
export type WebPage = { page: "repo" | "branch" | "file" | "commit" | "newPr" | "prs"; ref?: string; file?: string };
export function webLink(r: RemoteHost, p: WebPage): string {
  const ref = encodeURIComponent(p.ref ?? "");
  const file = (p.file ?? "").split("/").map(encodeURIComponent).join("/");
  const pages: Record<RemoteHost["kind"], Partial<Record<WebPage["page"], string>>> = {
    github: { branch: `/tree/${ref}`, file: `/blob/${ref}/${file}`, commit: `/commit/${ref}`, newPr: `/compare/${ref}?expand=1`, prs: "/pulls" },
    gitlab: { branch: `/-/tree/${ref}`, file: `/-/blob/${ref}/${file}`, commit: `/-/commit/${ref}`, newPr: `/-/merge_requests/new?merge_request%5Bsource_branch%5D=${ref}`, prs: "/-/merge_requests" },
    bitbucket: { branch: `/src/${ref}`, file: `/src/${ref}/${file}`, commit: `/commits/${ref}`, newPr: `/pull-requests/new?source=${ref}`, prs: "/pull-requests" },
    azure: { branch: `?version=GB${ref}`, file: `?path=/${file}&version=GB${ref}`, commit: `/commit/${ref}`, newPr: `/pullrequestcreate?sourceRef=${ref}`, prs: "/pullrequests" },
    other: {},
  };
  return r.web + (pages[r.kind][p.page] ?? "");
}
