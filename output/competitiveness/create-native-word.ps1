$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSCommandPath
$taskContent = Get-Content -LiteralPath (Join-Path $taskRoot 'content.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskDesktop = [Environment]::GetFolderPath('Desktop')
$taskTarget = Join-Path $taskDesktop 'CCAGENT项目核心竞争力说明.docx'
if (Test-Path -LiteralPath $taskTarget) { throw 'Destination already exists; preserve the existing document.' }
$taskPdf = Join-Path $taskRoot 'review.pdf'
$taskParagraphs = @(@{ Text=$taskContent.title; Style=-63 }, @{ Text=$taskContent.intro; Style=-1 })
foreach ($taskSection in $taskContent.sections) {
  $taskParagraphs += @{ Text=$taskSection.heading; Style=-2 }
  foreach ($taskParagraph in $taskSection.paragraphs) { $taskParagraphs += @{ Text=$taskParagraph; Style=-1 } }
}
$taskExpected = ($taskParagraphs.Text -join '') -replace '\s',''
if ($taskExpected.Length -gt 1500) { throw 'Content exceeds 1500 characters.' }
$taskWord = $null; $taskDocument = $null
try {
  $taskWord = New-Object -ComObject Word.Application
  $taskWord.Visible = $false
  $taskWord.DisplayAlerts = 0
  $taskDocument = $taskWord.Documents.Add()
  $taskDocument.PageSetup.PageWidth = 612
  $taskDocument.PageSetup.PageHeight = 792
  $taskDocument.PageSetup.TopMargin = 52
  $taskDocument.PageSetup.BottomMargin = 52
  $taskDocument.PageSetup.LeftMargin = 57.6
  $taskDocument.PageSetup.RightMargin = 57.6
  $taskNormal = $taskDocument.Styles.Item(-1)
  $taskNormal.Font.Name = 'Calibri'; $taskNormal.Font.NameFarEast = '宋体'
  $taskNormal.Font.Size = 11.5; $taskNormal.Font.Bold = 0; $taskNormal.Font.Color = 0
  $taskNormal.ParagraphFormat.Alignment = 3
  $taskNormal.ParagraphFormat.LineSpacingRule = 4; $taskNormal.ParagraphFormat.LineSpacing = 16
  $taskNormal.ParagraphFormat.SpaceBefore = 0; $taskNormal.ParagraphFormat.SpaceAfter = 4
  $taskNormal.ParagraphFormat.FirstLineIndent = 23
  $taskNormal.ParagraphFormat.WidowControl = -1
  $taskNormal.ParagraphFormat.KeepWithNext = 0
  $taskHeading = $taskDocument.Styles.Item(-2)
  $taskHeading.Font.Name = 'Calibri'; $taskHeading.Font.NameFarEast = '黑体'
  $taskHeading.Font.Size = 11.5; $taskHeading.Font.Bold = -1; $taskHeading.Font.Color = 0
  $taskHeading.Font.Underline = 0
  $taskHeading.ParagraphFormat.Alignment = 0
  $taskHeading.ParagraphFormat.FirstLineIndent = 0
  $taskHeading.ParagraphFormat.LineSpacingRule = 4; $taskHeading.ParagraphFormat.LineSpacing = 17
  $taskHeading.ParagraphFormat.SpaceBefore = 8; $taskHeading.ParagraphFormat.SpaceAfter = 3
  $taskHeading.ParagraphFormat.KeepWithNext = -1
  $taskTitle = $taskDocument.Styles.Item(-63)
  $taskTitle.Font.Name = 'Calibri'; $taskTitle.Font.NameFarEast = '黑体'
  $taskTitle.Font.Size = 18; $taskTitle.Font.Bold = -1; $taskTitle.Font.Color = 0; $taskTitle.Font.Underline = 0
  $taskTitle.ParagraphFormat.Alignment = 1
  $taskTitle.ParagraphFormat.FirstLineIndent = 0
  $taskTitle.ParagraphFormat.LineSpacingRule = 4; $taskTitle.ParagraphFormat.LineSpacing = 26
  $taskTitle.ParagraphFormat.SpaceBefore = 0; $taskTitle.ParagraphFormat.SpaceAfter = 12
  $taskTitle.ParagraphFormat.KeepWithNext = -1
  $taskTitle.ParagraphFormat.Borders.Enable = 0
  $taskDocument.Content.Text = ($taskParagraphs.Text -join "`r") + "`r"
  for ($taskIndex=0; $taskIndex -lt $taskParagraphs.Count; $taskIndex++) {
    $taskDocument.Paragraphs.Item($taskIndex+1).Range.Style = $taskDocument.Styles.Item([int]$taskParagraphs[$taskIndex].Style)
  }
  $taskDocument.Repaginate()
  $taskPages = $taskDocument.ComputeStatistics(2)
  $taskDocument.SaveAs2($taskTarget,16)
  $taskDocument.ExportAsFixedFormat($taskPdf,17)
  $taskActual = $taskDocument.Content.Text -replace '\s',''
  if ($taskActual -ne $taskExpected) { throw 'Word content verification failed.' }
  $taskReport = @{ file=$taskTarget; nonWhitespaceCharacters=$taskExpected.Length; withinLimit=$true; pages=$taskPages; nativeWordTextVerified=$true; pdf=$taskPdf; createdAt=(Get-Date).ToString('o') }
  $taskReport | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'verification.json') -Encoding UTF8
  $taskReport | ConvertTo-Json -Compress
} finally {
  if ($taskDocument) { $taskDocument.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskDocument) }
  if ($taskWord) { $taskWord.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskWord) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
