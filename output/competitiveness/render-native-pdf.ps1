$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$taskAsOperation = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$taskAsAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Wait-Operation($Operation,[Type]$ResultType) {
  $taskAsync = $script:taskAsOperation.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  $taskAsync.GetAwaiter().GetResult()
}
function Wait-Action($Operation) {
  $taskAsync = $script:taskAsAction.Invoke($null,@($Operation))
  $taskAsync.GetAwaiter().GetResult() | Out-Null
}
$taskRoot = Split-Path -Parent $PSCommandPath
$taskFile = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Join-Path $taskRoot 'review.pdf'))) ([Windows.Storage.StorageFile])
$taskPdf = Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($taskFile)) ([Windows.Data.Pdf.PdfDocument])
$taskOutput = @()
for ($taskIndex=0; $taskIndex -lt $taskPdf.PageCount; $taskIndex++) {
  $taskPage = $taskPdf.GetPage($taskIndex)
  $taskMemory = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $taskOptions = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $taskOptions.DestinationWidth = 1530
  Wait-Action ($taskPage.RenderToStreamAsync($taskMemory,$taskOptions))
  $taskInput = $taskMemory.GetInputStreamAt(0)
  $taskStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($taskInput)
  $taskPath = Join-Path $taskRoot ('page-' + ($taskIndex+1) + '.png')
  $taskOutputStream = [IO.File]::Create($taskPath)
  try { $taskStream.CopyTo($taskOutputStream) } finally { $taskOutputStream.Dispose(); $taskStream.Dispose(); $taskMemory.Dispose(); $taskPage.Dispose() }
  $taskOutput += $taskPath
}
@{ pages=$taskPdf.PageCount; images=$taskOutput; renderer='Native Word PDF and Windows PDF renderer' } | ConvertTo-Json -Compress
