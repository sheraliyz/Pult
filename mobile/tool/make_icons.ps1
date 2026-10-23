# Renders the Android launcher icons from the same glyph as the desktop icon.
#   powershell -File tool\make_icons.ps1   (run from the mobile folder)
Add-Type -AssemblyName System.Drawing
$res = Join-Path $PSScriptRoot '..\android\app\src\main\res'
$desktopIcon = Join-Path $PSScriptRoot '..\..\assets\icon.png'

function New-Canvas($n) {
  $bmp = New-Object System.Drawing.Bitmap($n, $n, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($bmp, $g)
}

# Glyph from the 512px desktop icon, scaled into the adaptive-icon safe zone.
function Draw-Glyph($g, $n) {
  $k = $n / 108.0
  $s = 0.2
  function P($x, $y) { New-Object System.Drawing.PointF([single]((54 + ($x - 259) * $s) * $k), [single]((54 + ($y - 244) * $s) * $k)) }
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 244, 244, 245), [single](36 * $s * $k))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((P 166 192), (P 242 256), (P 166 320)))
  $g.DrawLine($pen, (P 276 322), (P 350 322))
  $r = 20 * $s * $k
  $c = P 354 170
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 62, 207, 142))
  $g.FillEllipse($brush, [single]($c.X - $r), [single]($c.Y - $r), [single](2 * $r), [single](2 * $r))
}

$sizes = @{ 'mdpi' = 1; 'hdpi' = 1.5; 'xhdpi' = 2; 'xxhdpi' = 3; 'xxxhdpi' = 4 }
$src = [System.Drawing.Image]::FromFile((Resolve-Path $desktopIcon))
foreach ($d in $sizes.Keys) {
  $dir = Join-Path $res "mipmap-$d"
  New-Item -ItemType Directory -Force $dir | Out-Null
  # Legacy icon (Android < 8): the desktop icon itself.
  $n = [int](48 * $sizes[$d])
  $bmp, $g = New-Canvas $n
  $g.DrawImage($src, 0, 0, $n, $n)
  $bmp.Save((Join-Path $dir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  # Adaptive foreground (Android 8+), 108dp.
  $n = [int](108 * $sizes[$d])
  $bmp, $g = New-Canvas $n
  Draw-Glyph $g $n
  $bmp.Save((Join-Path $dir 'ic_launcher_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$src.Dispose()
'icons written'
