$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'resources\ai-runtime\win-x64'
$exe = Join-Path $runtime 'llama-server.exe'
$model = Join-Path $root 'resources\models\Qwen2.5-0.5B-Instruct-Q4_0.gguf'
$stdout = Join-Path $env:TEMP 'ai-player-llama-stdout.log'
$stderr = Join-Path $env:TEMP 'ai-player-llama-stderr.log'
$arguments = @(
  '--model', ('"' + $model + '"'),
  '--host', '127.0.0.1', '--port', '11555',
  '--alias', 'ai-player-qwen2.5-0.5b',
  '--ctx-size', '2048', '--threads', '4', '--threads-batch', '4',
  '--batch-size', '128', '--ubatch-size', '128',
  '--gpu-layers', '0', '--jinja', '--no-webui'
)

$process = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $runtime `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru

try {
  $models = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) {
      $tail = Get-Content -LiteralPath $stderr -Tail 20 -ErrorAction SilentlyContinue
      throw "llama-server exited $($process.ExitCode): $tail"
    }
    try {
      $models = Invoke-RestMethod -Uri 'http://127.0.0.1:11555/v1/models' -Proxy $null -TimeoutSec 2
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $models) { throw 'llama-server readiness timeout' }

  $request = @{
    model = 'ai-player-qwen2.5-0.5b'
    messages = @(@{ role = 'user'; content = '请用一句简短中文回答：你能在不连接云端的情况下工作吗？' })
    max_tokens = 64
    temperature = 0.2
    top_p = 0.8
  } | ConvertTo-Json -Depth 6
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11555/v1/chat/completions' -Method Post `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($request)) `
    -Proxy $null -TimeoutSec 120
  $timer.Stop()

  [pscustomobject]@{
    pid = $process.Id
    model = $models.data[0].id
    answer = $response.choices[0].message.content
    seconds = [math]::Round($timer.Elapsed.TotalSeconds, 2)
    prompt_tokens = $response.usage.prompt_tokens
    completion_tokens = $response.usage.completion_tokens
  } | ConvertTo-Json -Depth 5
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
