# pack-alpha.ps1 — robusto (extrae PNG RGBA y reempaqueta en MP4 packed)
# Requisitos: ffmpeg en PATH
param(
    [Parameter(Position=0,Mandatory=$true)]
    [string]$InputFile
)

# -------- helpers / comprobaciones --------
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "❌ ffmpeg no encontrado en PATH. Instala ffmpeg y vuelve a intentarlo." -ForegroundColor Red
    exit 1
}

# Resuelve ruta absoluta (soporta arrastrar o pasar solo nombre)
try {
    $resolved = Resolve-Path -Path $InputFile -ErrorAction Stop
    $fullIn  = $resolved.Path
} catch {
    Write-Host "❌ No existe o no se puede resolver: $InputFile" -ForegroundColor Red
    exit 1
}

$base = [IO.Path]::GetFileNameWithoutExtension($fullIn)
$inDir = [IO.Path]::GetDirectoryName($fullIn)
if ([string]::IsNullOrEmpty($inDir)) { $inDir = (Get-Location).Path }

$tmpDir = Join-Path $inDir ("_tmp_" + $base)
$outFile = Join-Path $inDir ($base + "_packed.mp4")
$pngPat = Join-Path $tmpDir "f_%05d.png"

# Limpia / crea tmp
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
New-Item -ItemType Directory -Path $tmpDir | Out-Null

Write-Host "🖼 1/3 Exportando PNG RGBA desde:" $fullIn -ForegroundColor Cyan
# Exporta secuencia PNG RGBA (forzamos decoder libvpx-vp9 por si hace falta)
$args1 = @(
    "-y",
    "-hide_banner",
    "-loglevel","error",
    "-c:v","libvpx-vp9",
    "-i", $fullIn,
    "-vf","format=yuva420p,format=rgba",
    "$pngPat"
)
$proc = Start-Process -FilePath "ffmpeg" -ArgumentList $args1 -NoNewWindow -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    Write-Host "❌ Error exportando PNGs (exit $($proc.ExitCode))." -ForegroundColor Red
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "🎛 2/3 Empaquetando color + alpha en MP4 (esto puede tardar)..." -ForegroundColor Cyan

# Filtro: leer PNG RGBA -> separar color y alpha -> apilar color arriba, alpha abajo
$filter = "[0:v]format=rgba,split=2[c][a];" +
          "[c]format=rgb24,setsar=1,scale=trunc(iw/2)*2:floor(ih/2)[color];" +
          "[a]alphaextract,format=gray,setsar=1,scale=trunc(iw/2)*2:floor(ih/2)[alpha];" +
          "[color][alpha]vstack=inputs=2[outv]"

$args2 = @(
    "-y",
    "-hide_banner",
    "-loglevel","error",
    "-framerate","25",
    "-start_number","0",
    "-i", $pngPat,
    "-filter_complex", $filter,
    "-map", "[outv]",
    "-an",
    "-c:v","libx264",
    "-crf","18",
    "-preset","medium",
    "-pix_fmt","yuv420p",
    "-movflags","+faststart",
    $outFile
)
$proc2 = Start-Process -FilePath "ffmpeg" -ArgumentList $args2 -NoNewWindow -Wait -PassThru
if ($proc2.ExitCode -ne 0) {
    Write-Host "❌ Error generando MP4 (exit $($proc2.ExitCode))." -ForegroundColor Red
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "🧹 Limpiando temporales..." -ForegroundColor Yellow
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "🖼 3/3 Generando previews..." -ForegroundColor Cyan
# Preview del MP4 (primer frame)
& ffmpeg -y -hide_banner -loglevel error -i $outFile -vframes 1 (Join-Path $inDir ($base + "_packed_preview.png"))
# Preview del alpha original (primer frame)
& ffmpeg -y -hide_banner -loglevel error -i $fullIn -vf "format=yuva420p,extractplanes=a,format=gray" -vframes 1 (Join-Path $inDir ($base + "_alpha_preview.png"))

Write-Host ""
Write-Host "✅ Hecho:" $outFile -ForegroundColor Green
Write-Host "   Previews: ${base}_packed_preview.png   ${base}_alpha_preview.png" -ForegroundColor Gray
