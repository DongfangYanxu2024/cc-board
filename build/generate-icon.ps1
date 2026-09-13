Add-Type -AssemblyName System.Drawing

$buildDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pngPath = Join-Path $buildDir "icon.png"
$icoPath = Join-Path $buildDir "icon.ico"
$bitmap = [Drawing.Bitmap]::new(512, 512)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([Drawing.Color]::Transparent)

$background = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(42, 77, 61))
$path = [Drawing.Drawing2D.GraphicsPath]::new()
$radius = 92
$path.AddArc(18, 18, $radius, $radius, 180, 90)
$path.AddArc(494 - $radius, 18, $radius, $radius, 270, 90)
$path.AddArc(494 - $radius, 494 - $radius, $radius, $radius, 0, 90)
$path.AddArc(18, 494 - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()
$graphics.FillPath($background, $path)

$white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
$font = [Drawing.Font]::new("Segoe UI", 176, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString("cc", $font, $white, 71, 137)
$accent = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(231, 180, 99))
$graphics.FillRectangle($accent, 339, 229, 104, 58)
$bitmap.Save($pngPath, [Drawing.Imaging.ImageFormat]::Png)

$pngBytes = [IO.File]::ReadAllBytes($pngPath)
$stream = [IO.File]::Create($icoPath)
$writer = [IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$pngBytes.Length)
$writer.Write([UInt32]22)
$writer.Write($pngBytes)
$writer.Dispose()
$stream.Dispose()
$font.Dispose()
$white.Dispose()
$accent.Dispose()
$background.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated $icoPath"
