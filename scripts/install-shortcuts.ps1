# Creates "ClaudeDesk" shortcuts on the Desktop and in the Start menu that start the app with no terminal window.
# Run again after moving the repo. Delete the two .lnk files to remove them.
$repo = Split-Path -Parent $PSScriptRoot
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$runner = Join-Path $repo "scripts\run-dev.cmd"
$icon = Join-Path $repo "node_modules\electron\dist\electron.exe"
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath("Desktop"),
  (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs")
)
foreach ($dir in $targets) {
  $link = $shell.CreateShortcut((Join-Path $dir "ClaudeDesk.lnk"))
  $link.TargetPath = $conhost
  $link.Arguments = "--headless cmd.exe /d /c `"$runner`""
  $link.WorkingDirectory = $repo
  $link.WindowStyle = 7
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.Description = "ClaudeDesk (runs without a terminal window)"
  $link.Save()
  Write-Output "Created $(Join-Path $dir 'ClaudeDesk.lnk')"
}
