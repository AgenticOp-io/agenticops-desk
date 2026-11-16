# Draws build/icon.png (512) and build/icon.ico (256, PNG-embedded). Run: pwsh scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$s = 512
$bmp = New-Object System.Drawing.Bitmap $s, $s
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
# rounded dark tile with a teal-to-blue gradient
$r = 112; $d = $r * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($s - $d, 0, $d, $d, 270, 90)
$path.AddArc($s - $d, $s - $d, $d, $d, 0, 90); $path.AddArc(0, $s - $d, $d, $d, 90, 90); $path.CloseFigure()
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0, 0)), ([System.Drawing.Point]::new($s, $s)), ([System.Drawing.Color]::FromArgb(24, 32, 48)), ([System.Drawing.Color]::FromArgb(10, 14, 22))
$g.FillPath($bg, $path)
# "A" built from two strokes, with a node at the apex and a crossbar linking two nodes
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(45, 212, 191)), 40
$pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
$g.DrawLines($pen, [System.Drawing.Point[]]@([System.Drawing.Point]::new(120, 408), [System.Drawing.Point]::new(256, 104), [System.Drawing.Point]::new(392, 408)))
$pen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(96, 165, 250)), 28
$pen2.StartCap = 'Round'; $pen2.EndCap = 'Round'
$g.DrawLine($pen2, 188, 296, 324, 296)
$white = [System.Drawing.Brushes]::White
foreach ($p in @(@(256, 104), @(188, 296), @(324, 296))) { $g.FillEllipse($white, $p[0] - 24, $p[1] - 24, 48, 48) }
$g.Dispose()
$out = Join-Path $PSScriptRoot '..\build'
$png = Join-Path $out 'icon.png'
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
# 256px PNG inside an ICO container
$b2 = New-Object System.Drawing.Bitmap $bmp, 256, 256
$ms = New-Object System.IO.MemoryStream; $b2.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$data = $ms.ToArray()
$fs = [System.IO.File]::Create((Join-Path $out 'icon.ico')); $w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
$w.Write([uint32]$data.Length); $w.Write([uint32]22); $w.Write($data); $w.Close()
