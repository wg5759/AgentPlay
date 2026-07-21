param(
  [string]$Source,
  [string]$Target,
  [ValidateSet('Word', 'Excel', 'PowerPoint')][string]$App = 'Word',
  [switch]$ProbeEngines,
  [switch]$Print
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($ProbeEngines) {
  foreach ($prog in 'Word.Application', 'Excel.Application', 'PowerPoint.Application') {
    $instance = $null
    try {
      $instance = New-Object -ComObject $prog
      $name = $prog.Split('.')[0].ToUpper()
      Write-Output ("ENGINE-OK " + $name + " " + $instance.Version)
    } catch {
      $name = $prog.Split('.')[0].ToUpper()
      Write-Output ("ENGINE-FAIL " + $name + " " + $_.Exception.Message)
    } finally {
      if ($instance) { try { $instance.Quit() } catch { } }
    }
  }
  exit 0
}

if (-not $Source -or (-not $Print -and -not $Target)) { throw '缺少 Source 或 Target 参数' }
$office = $null
try {
  switch ($App) {
    'Word' {
      $office = New-Object -ComObject Word.Application
      $office.Visible = $false
      $office.DisplayAlerts = 0
      try { $office.AutomationSecurity = 3 } catch { }
      $doc = $office.Documents.Open($Source, $false, $true)
      try {
        if ($Print) { $doc.PrintOut() }
        else {
          try { $doc.ExportAsFixedFormat($Target, 0) }
          catch { $doc.SaveAs([ref]$Target, [ref]17) }
        }
      } finally { $doc.Close($false) }
    }
    'Excel' {
      $office = New-Object -ComObject Excel.Application
      $office.Visible = $false
      $office.DisplayAlerts = $false
      try { $office.AutomationSecurity = 3 } catch { }
      $wb = $office.Workbooks.Open($Source, 0, $true)
      try {
        if ($Print) { $wb.PrintOut() }
        else { $wb.ExportAsFixedFormat(0, $Target) }
      }
      finally { $wb.Close($false) }
    }
    'PowerPoint' {
      $office = New-Object -ComObject PowerPoint.Application
      try { $office.AutomationSecurity = 3 } catch { }
      $pres = $office.Presentations.Open($Source, $true, $true, $false)
      try {
        if ($Print) { $pres.PrintOut() }
        else {
          try { $pres.ExportAsFixedFormat($Target, 2) }
          catch { $pres.SaveAs($Target, 32) }
        }
      } finally { $pres.Close() }
    }
  }
  if ($Print) { Write-Output "PRINT-OK $Source" }
  else { Write-Output "CONVERT-OK $Target" }
} finally {
  if ($office) { try { $office.Quit() } catch { } }
}
