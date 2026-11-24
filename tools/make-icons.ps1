# NSN Field Explorer icon: code braces inside a magnifier, on a rounded-square tile. Colors are from the Syincuso brand
# kit: a rich black tile, a white lens ring, gold braces and a firebrick handle (chosen 2026-11-12 from the icon workshop).
# The toolbar sizes, 16 and 32 px (Chrome uses the 32 px one on high-resolution screens), use -Simple: no braces, and a
# bold magnifier spanning about 90% of the tile, so it still looks full-size where a dark toolbar swallows the black tile.
# -Scale enlarges the magnifier in the 48 and 128 px icons (1.22: it fills the tile like other extension icons). The
# handle runs off the corner and is clipped by the tile.
param([string]$OutDir, [string]$PreviewPath, [string]$Tile = '#0B0B0B', [string]$Ring = '#FFFFFF', [string]$Braces = '#C9A227', [string]$Handle = '#B22222', [double]$Scale = 1.22)
Add-Type -AssemblyName System.Drawing

# Design is in a 128-unit grid, drawn at 512px (scale 4) and downsampled for smooth edges.
function New-Master([switch]$Simple) {
  $S = 4; $N = 128 * $S
  $bmp = New-Object System.Drawing.Bitmap $N, $N, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $html = { param($c) [System.Drawing.ColorTranslator]::FromHtml($c) }
  $tileC = & $html $Tile; $ringC = & $html $Ring; $bracesC = & $html $Braces; $handleC = & $html $Handle

  # Rounded-square tile (120 units, corner radius 28)
  $inset = 4 * $S; $r = 28 * $S; $w = 120 * $S
  $tilePath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tilePath.AddArc($inset, $inset, 2*$r, 2*$r, 180, 90)
  $tilePath.AddArc($inset + $w - 2*$r, $inset, 2*$r, 2*$r, 270, 90)
  $tilePath.AddArc($inset + $w - 2*$r, $inset + $w - 2*$r, 2*$r, 2*$r, 0, 90)
  $tilePath.AddArc($inset, $inset + $w - 2*$r, 2*$r, 2*$r, 90, 90)
  $tilePath.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $tileC), $tilePath)

  # Everything else is clipped to the tile; the 48 and 128 px design is scaled about the magnifier's centre (62, 61).
  $g.SetClip($tilePath)
  if (-not $Simple) { $g.TranslateTransform(62*$S, 61*$S); $g.ScaleTransform($Scale, $Scale); $g.TranslateTransform(-62*$S, -61*$S) }

  # Lens ring and handle
  if ($Simple) { $cx = 52; $cy = 52; $lr = 34; $rw = 22; $hw = 26; $h1 = @(78, 78); $h2 = @(120, 120) }
  else { $cx = 56; $cy = 55; $lr = 30; $rw = 10; $hw = 15; $h1 = @(79, 78); $h2 = @(100, 99) }
  $ring = New-Object System.Drawing.Pen $ringC, ($rw * $S)
  $g.DrawEllipse($ring, ($cx-$lr)*$S, ($cy-$lr)*$S, 2*$lr*$S, 2*$lr*$S)
  $h = New-Object System.Drawing.Pen $handleC, ($hw * $S)
  $h.StartCap = 'Round'; $h.EndCap = 'Round'
  $g.DrawLine($h, $h1[0]*$S, $h1[1]*$S, $h2[0]*$S, $h2[1]*$S)

  # Braces { } inside the lens: lines and quadratic curves (each curve becomes a cubic Bezier).
  if (-not $Simple) {
    $pen = New-Object System.Drawing.Pen $bracesC, (5 * $S)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    foreach ($side in -1, 1) {
      $x0 = if ($side -lt 0) { 50 } else { 62 }
      $q = { param($p, $c, $e) $path.AddBezier($p[0]*$S, $p[1]*$S, ($p[0] + 2*($c[0]-$p[0])/3)*$S, ($p[1] + 2*($c[1]-$p[1])/3)*$S, ($e[0] + 2*($c[0]-$e[0])/3)*$S, ($e[1] + 2*($c[1]-$e[1])/3)*$S, $e[0]*$S, $e[1]*$S) }
      $path = New-Object System.Drawing.Drawing2D.GraphicsPath
      $xs = $x0 + 6*$side; $xt = $x0 + 11*$side
      & $q @($x0, 40) @($xs, 40) @($xs, 46)
      $path.AddLine($xs*$S, 46*$S, $xs*$S, 50*$S)
      & $q @($xs, 50) @($xs, 54) @($xt, 55)
      & $q @($xt, 55) @($xs, 56) @($xs, 60)
      $path.AddLine($xs*$S, 60*$S, $xs*$S, 64*$S)
      & $q @($xs, 64) @($xs, 70) @($x0, 70)
      $g.DrawPath($pen, $path)
    }
  }
  $g.Dispose()
  return $bmp
}

function Resize($src, $size) {
  $b = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'AntiAlias'
  $g.DrawImage($src, 0, 0, $size, $size); $g.Dispose()
  return $b
}

$master = New-Master
New-Item -ItemType Directory -Force $OutDir | Out-Null
$imgs = @{}
$simple = New-Master -Simple
foreach ($s in 16, 32, 48, 128) {
  $imgs[$s] = Resize ($(if ($s -le 32) { $simple } else { $master })) $s
  $imgs[$s].Save((Join-Path $OutDir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
}

# Preview: each size shown actual-size and enlarged (nearest neighbor), on light and dark strips
$pv = New-Object System.Drawing.Bitmap 760, 420
$g = [System.Drawing.Graphics]::FromImage($pv)
$g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, 760, 210)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#202124'))), 0, 210, 760, 210)
$g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
foreach ($row in 0, 210) {
  $x = 20
  foreach ($s in 16, 32, 48, 128) { $g.DrawImage($imgs[$s], $x, $row + 20, $s, $s); $x += $s + 20 }
  $g.DrawImage($imgs[16], 400, $row + 20, 128, 128)
  $g.DrawImage($imgs[32], 560, $row + 20, 128, 128)
}
$g.Dispose()
$pv.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
"done"

