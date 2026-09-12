# Self-test for the WeChat search-row / conversation-header matching used by the
# injector (pure functions on OCR output captured from the real client, so no WeChat,
# no screen and no OCR engine are needed to run it).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/wechat-ocr-selftest.ps1
#   npm run test:win
#
# Why it must exist: WeChat 4.x keeps a "search the web" block (plus query
# suggestions) on top of the search dropdown, so "type the name, press Enter" opens
# something that is not the chat. The injector now clicks the row OCR says is the
# target and re-reads the conversation header before typing. Those two decisions are
# what keeps a message out of the wrong group - they are pinned down here.
#
# NOTE: keep this file ASCII-only (PS 5.1 parses no-BOM scripts as ANSI); the Chinese
# fixtures live in scripts/fixtures/wechat-ocr-lines.json and are read as UTF-8.

. (Join-Path $PSScriptRoot '..\resources\ps\wechat-ocr.ps1')

$script:failed = 0

function Check {
  param([bool]$Ok, [string]$Name, [string]$Detail = '')
  if (-not $Ok) { $script:failed++ }
  $tag = '  ok  '
  if (-not $Ok) { $tag = ' FAIL ' }
  $line = $tag + ' ' + $Name
  if ($Detail -ne '') { $line = $line + ' - ' + $Detail }
  Write-Host $line
}

function To-Lines($Rows) {
  $out = New-Object System.Collections.ArrayList
  foreach ($r in $Rows) {
    [void]$out.Add([pscustomobject]@{ text = $r.text; x = $r.x; y = $r.y; w = $r.w; h = $r.h })
  }
  return ,$out
}

$fx = Get-Content (Join-Path $PSScriptRoot 'fixtures\wechat-ocr-lines.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$fieldBottom = 70   # fixture geometry: the search field row sits at y=48..64
$target = $fx.targetGroup
$names = @($fx.names)
$search = To-Lines $fx.searchLines
$miss = To-Lines $fx.searchLinesMiss
$headerOk = To-Lines $fx.headerLinesOk
$headerWrong = To-Lines $fx.headerLinesWrong

Write-Host ''
Write-Host '[1] folding + scoring'
Check ((ConvertTo-WxName $fx.searchLines[6].text) -eq (ConvertTo-WxName $target)) 'spaced OCR glyphs fold to the real name' (ConvertTo-WxName $fx.searchLines[6].text)
Check ((Get-WxNameScore $target $target) -eq 1.0) 'identical names score 1.0'
$sSug = Get-WxNameScore $fx.searchLines[2].text $target
Check ($sSug -ge 0.7) 'a query-suggestion row scores close to the row threshold' ('score=' + [Math]::Round($sSug, 2))
$trap = @($search) + [pscustomobject]@{ text = '0 ' + $fx.searchLines[6].text; x = 94; y = 113; w = 92; h = 13 }
$sTrap = Get-WxNameScore $trap[$trap.Count - 1].text $target
Check ($sTrap -ge 0.8) 'a suggestion row carrying the EXACT name still clears the row threshold' ('score=' + [Math]::Round($sTrap, 2))
$rowTrap = Select-WxSearchRow -Lines @($trap) -Target $target -IsGroup $true -BelowY $fieldBottom
Check ($null -ne $rowTrap -and $rowTrap.y -eq 230) 'and is still not clicked: only rows under the group header count' ('y=' + $rowTrap.y)
$sOther = Get-WxNameScore $fx.names[2] $target
Check ($sOther -lt 0.8) 'two store groups sharing prefix/suffix stay below the row threshold' ('score=' + [Math]::Round($sOther, 2))
$headerLine = $fx.headerLinesOk[1].text
Check ((ConvertTo-WxNameWithoutTrailingDigits $headerLine).Length -eq (ConvertTo-WxName $target).Length) 'unread counter appended to the header is dropped for matching' (ConvertTo-WxNameWithoutTrailingDigits $headerLine)

Write-Host ''
Write-Host '[2] row selection on the real dropdown (search the web on top, group row under the group header)'
$row = Select-WxSearchRow -Lines @($search) -Target $target -IsGroup $true -BelowY $fieldBottom
Check ($null -ne $row) 'a row was found'
if ($null -ne $row) {
  Check ($row.y -eq 230) 'picked the group row (y=230), not the web block or the suggestion rows' ('y=' + $row.y)
  Check ((ConvertTo-WxName $row.text) -ne $script:WxLblSearchWeb) 'never picks the "search the web" row'
} 
Check (($null -eq (Select-WxSearchRow -Lines @($search) -Target $target -IsGroup $true -BelowY $fieldBottom -MinScore 1.01))) 'nothing matches => refuse (caller aborts instead of pressing Enter)'
Check (($null -eq (Select-WxSearchRow -Lines @($miss) -Target $target -IsGroup $true -BelowY $fieldBottom))) 'target missing from the dropdown => refuse'
Check (($null -eq (Select-WxSearchRow -Lines @($search) -Target $target -IsGroup $false -BelowY $fieldBottom))) 'contact target is not satisfied by a group-section row'
$common = To-Lines $fx.searchLinesCommon
$rowCommon = Select-WxSearchRow -Lines @($common) -Target $target -IsGroup $true -BelowY $fieldBottom
Check ($null -ne $rowCommon -and $rowCommon.y -eq 130) 'a hit listed under the "frequently used" block is still clickable' ('y=' + $rowCommon.y)
Check ($null -ne $rowCommon -and $rowCommon.section -eq 'common') 'and is reported as a frequently-used row' ($rowCommon.section)
foreach ($variant in $script:WxLblCommonForms) {
  $lines2 = @($common | ForEach-Object { if ($_.y -eq 82) { [pscustomobject]@{ text = $variant; x = $_.x; y = $_.y; w = $_.w; h = $_.h } } else { $_ } })
  $rv = Select-WxSearchRow -Lines $lines2 -Target $target -IsGroup $true -BelowY $fieldBottom
  Check ($null -ne $rv -and $rv.y -eq 130) "the block header also matches the OCR reading [$variant]" ('y=' + $rv.y)
}
$webOnly = @($search | Where-Object { $_.y -lt 182 })
Check (($null -eq (Select-WxSearchRow -Lines $webOnly -Target $target -IsGroup $true -BelowY $fieldBottom))) 'no dropdown header on screen => refuse (never blind-click)'

Write-Host ''
Write-Host '[3] conversation header check: the chat that actually got opened'
$mOk = Get-WxHeaderMatch -Lines @($headerOk) -Target $target -Names $names
Check ($mOk.direct -ge 0.6) 'header of the right chat passes the score floor' ('direct=' + [Math]::Round($mOk.direct, 2))
Check ($mOk.direct -ge ($mOk.bestScore - 0.02)) 'and is not beaten by another known session' ('best=' + $mOk.bestName + ' ' + [Math]::Round($mOk.bestScore, 2))
Check ($mOk.direct -ge 0.8) 'readable header (one OCR typo) still scores clearly' ('direct=' + [Math]::Round($mOk.direct, 2))

$mWrong = Get-WxHeaderMatch -Lines @($headerWrong) -Target $target -Names $names
Check ($mWrong.bestName -ne $target) 'similar-but-different group is identified as another session' ('best=' + $mWrong.bestName)
Check (-not ($mWrong.direct -ge 0.6 -and $mWrong.direct -ge ($mWrong.bestScore - 0.02))) 'wrong chat is REFUSED (no keystroke reaches the chat)' ('direct=' + [Math]::Round($mWrong.direct, 2) + ' best=' + [Math]::Round($mWrong.bestScore, 2))

Write-Host ''
Write-Host '[4] header check without a session list (names file missing)'
$mNoNames = Get-WxHeaderMatch -Lines @($headerOk) -Target $target -Names @()
Check ($mNoNames.direct -ge 0.6) 'still accepts a header that plainly matches the target' ('direct=' + [Math]::Round($mNoNames.direct, 2))
$mNoNamesWrong = Get-WxHeaderMatch -Lines @($headerWrong) -Target $target -Names @()
Check ($mNoNamesWrong.direct -lt 0.8) 'and still scores a different group far lower' ('direct=' + [Math]::Round($mNoNamesWrong.direct, 2))

Write-Host ''
Write-Host '[5] header strip is bounded: message text further down can not fake a match'
$deep = To-Lines @(
  @{ text = '0'; x = 398; y = 700; w = 12; h = 12 },
  @{ text = $target; x = 550; y = 320; w = 100; h = 12 }
)
$mDeep = Get-WxHeaderMatch -Lines $deep -Target $target -Names $names
Check ($mDeep.direct -lt 0.6) 'a chat name in the message area is outside the header strip' ('direct=' + [Math]::Round($mDeep.direct, 2))

Write-Host ''
Write-Host '[6] guards added for the "click blind" and "press Enter blind" failure modes'
# click points are clamped into the window; OwnerPid 0 skips the on-screen verification
$rc = @(1000, 500, 800, 700)
$inside = Resolve-WxClickPoint -Rect $rc -X 1130 -Y 552 -OwnerPid 0
Check ($inside[0] -eq 1130 -and $inside[1] -eq 552) 'a point inside the window is used as-is' ($inside -join ',')
$outside = Resolve-WxClickPoint -Rect $rc -X 5000 -Y 9000 -OwnerPid 0
Check ($outside[0] -le 1792 -and $outside[1] -le 1192 -and $outside[0] -ge 1008 -and $outside[1] -ge 508) 'a point outside the window is clamped inside it' ($outside -join ',')
Check ($null -eq (Resolve-WxClickPoint -Rect @(0, 0, 10, 10) -X 5 -Y 5 -OwnerPid 0)) 'a window too small to click safely returns nothing (caller aborts)'

# the chat input read back before Enter
$body = $fx.headerLinesOk[1].text
Check (Test-WxTextLanded -Text ('Q ' + $body) -Target $body) 'an OCR line with an icon prefix still counts as landed'
$composerHit = @([pscustomobject]@{ text = $body; x = 520; y = 640; w = 400; h = 12 })
Check (Test-WxComposerHasBody -Lines $composerHit -Text $body -WinW 802 -WinH 771) 'body found in the composer band => Enter may be pressed'
$composerEmpty = @([pscustomobject]@{ text = 'send'; x = 700; y = 720; w = 30; h = 12 })
Check (-not (Test-WxComposerHasBody -Lines $composerEmpty -Text $body -WinW 802 -WinH 771)) 'empty composer => refuse to press Enter'
$composerAbove = @([pscustomobject]@{ text = $body; x = 520; y = 560; w = 400; h = 12 })
Check (-not (Test-WxComposerHasBody -Lines $composerAbove -Text $body -WinW 802 -WinH 771)) 'an old message bubble above the band can not stand in for the composer'
# a long body only shows a fragment in the input box (head when short, tail once it scrolls)
$long = 'HEAD-MARKER ' + $body + ' TAIL-MARKER'
$composerHead = @([pscustomobject]@{ text = ($body.Substring(0, 9)); x = 520; y = 640; w = 200; h = 12 })
Check (Test-WxComposerHasBody -Lines $composerHead -Text ('prefix ' + $body) -WinW 802 -WinH 771) 'a long body shown as a visible HEAD still counts'
$composerTail = @([pscustomobject]@{ text = 'TAIL-MARKER'; x = 520; y = 640; w = 200; h = 12 })
Check (Test-WxComposerHasBody -Lines $composerTail -Text $long -WinW 802 -WinH 771) 'a scrolled-to-tail body still counts (fragment containment)'
$composerOther = @([pscustomobject]@{ text = 'DIFFERENT-DRAFT-TEXT 9999'; x = 520; y = 640; w = 200; h = 12 })
Check (-not (Test-WxComposerHasBody -Lines $composerOther -Text $long -WinW 802 -WinH 771)) 'unrelated text in the box does NOT count'

Write-Host ''
Write-Host '[7b] 1:1 contact hits sit ABOVE every section header (and OCR misses that header)'
$contact = To-Lines $fx.contactLines
$ctarget = $fx.targetContact
$cRow = Select-WxSearchRow -Lines @($contact) -Target $ctarget -IsGroup $false -BelowY 66
Check ($null -ne $cRow -and $cRow.y -eq 130) 'contact row above all headers is still clickable' ('y=' + $cRow.y)
Check ($null -ne $cRow -and $cRow.section -eq 'none') 'and reports no section (that is what the header check is for)' ($cRow.section)
$gRow = Select-WxSearchRow -Lines @($contact) -Target $ctarget -IsGroup $true -BelowY 66
Check ($null -ne $gRow -and $gRow.section -eq 'group') 'the SAME frame for a group target stays inside the group block' ('section=' + $gRow.section + ' y=' + $gRow.y)
# canary: with no boundary the FIELD row is the best match and would be clicked - that is
# exactly why BelowY is a mandatory parameter instead of defaulting to 0
$fieldRow = Select-WxSearchRow -Lines @($contact) -Target $ctarget -IsGroup $false -BelowY 0
Check ($null -ne $fieldRow -and $fieldRow.y -eq 48) 'no boundary => the field row itself wins (parameter is mandatory for this reason)' ('y=' + $fieldRow.y)
$rowNoField = Select-WxSearchRow -Lines @($contact) -Target $ctarget -IsGroup $false -BelowY 80
Check ($null -ne $rowNoField -and $rowNoField.y -eq 130) 'with the production default boundary the field line is excluded' ('y=' + $rowNoField.y)
# the same row as the client elides it (fixture text cut short, no literals needed)
$truncFrame = @(
  [pscustomobject]@{ text = ($fx.contactLines[3].text.Substring(0, 24)); x = 136; y = 130; w = 120; h = 14 },
  [pscustomobject]@{ text = $fx.searchLines[4].text; x = 92; y = 244; w = 24; h = 11 }
)
$trunc = Select-WxSearchRow -Lines $truncFrame -Target $ctarget -IsGroup $false -BelowY 80
Check ($null -ne $trunc -and $trunc.y -eq 130 -and $trunc.truncated) 'an elided result row (long name) is still accepted, flagged truncated' ('y=' + $trunc.y + ' truncated=' + $trunc.truncated)

Write-Host ''
Write-Host '[7c] built-in targets sit under a features block, below the web-suggestion block'
$feature = To-Lines $fx.featureLines
$fTarget = $fx.targetFeature
$fRow = Select-WxSearchRow -Lines @($feature) -Target $fTarget -IsGroup $false -BelowY 66
Check ($null -ne $fRow -and $fRow.y -eq 332) 'row under the features block is clickable' ('y=' + $fRow.y)
Check ($null -ne $fRow -and $fRow.section -eq 'other') 'and is not mistaken for a web suggestion' ($fRow.section)
$sug = @($fx.featureLines | Where-Object { $_.y -lt 284 })
$fSug = Select-WxSearchRow -Lines (To-Lines $sug) -Target $fTarget -IsGroup $false -BelowY 66
Check ($null -eq $fSug) 'without that header the same rows would be refused (why the label list matters)'

Write-Host ''
Write-Host '[8] dynamic layout anchors (search box found by looking, not by a fixed offset)'
$top = To-Lines $fx.topBandLines
$boxLine = Find-WxSearchBoxLine -Lines @($top) -WinW 802 -WinH 771
Check ($null -ne $boxLine) 'search box found in the top band'
Check ($null -ne $boxLine -and $boxLine.x -eq 88) 'the leftmost short run wins, not the icons or the chat title' ('x=' + $boxLine.x + ' text=[' + $boxLine.text + ']')
Check ((Find-WxPaneLeft -Lines @($top) -WinW 802 -WinH 771) -eq 446) 'conversation pane edge comes from the chat title'
$noHeader = @($fx.topBandLines | Where-Object { $_.x -lt 400 })
Check ((Find-WxPaneLeft -Lines (To-Lines $noHeader) -WinW 802 -WinH 771) -eq 0) 'no title on screen => 0 so callers fall back to the width share'
$paneLeft = Find-WxPaneLeft -Lines @($top) -WinW 802 -WinH 771
$composerDyn = @([pscustomobject]@{ text = $target; x = 452; y = 630; w = 84; h = 12 })
Check (Test-WxComposerHasBody -Lines $composerDyn -Text $target -WinW 802 -WinH 771 -PaneLeft $paneLeft) 'composer check works with the dynamically found pane edge'
Check (-not (Test-WxComposerHasBody -Lines $composerDyn -Text $target -WinW 802 -WinH 771 -PaneLeft 600)) 'text left of the pane edge is not counted as the composer'
Check ($null -eq (Find-WxSearchBoxLine -Lines @() -WinW 802 -WinH 771)) 'empty screen => no anchor, caller falls back'
Check ($null -eq (Find-WxSearchBoxLine -Lines @($top) -WinW 0 -WinH 0)) 'unknown window size => refuse to guess'

Write-Host ''
Write-Host '[7] human pacing: no fixed metronome, but never absurd either'
$lo = 999; $hi = -999; $zero = $true; $above = $true
for ($i = 0; $i -lt 300; $i++) {
  $v = Get-WxJitter -Base 100 -Spread 40
  if ($v -lt $lo) { $lo = $v }
  if ($v -gt $hi) { $hi = $v }
  if ($v -ne 100) { $zero = $false }
}
Check ($lo -ge 60 -and $hi -le 140) 'jitter stays inside base +/- spread' ("range $lo..$hi")
Check (-not $zero) 'jitter is actually random (not the fixed base)'
Check ((Get-WxJitter -Base 500 -Spread 0) -eq 500) 'zero spread means no jitter'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Start-WxPause -Base 120 -Spread 20 -Hesitate $false
$sw.Stop()
Check ($sw.ElapsedMilliseconds -ge 90) 'a pause really waits (no busy loop)' ("$($sw.ElapsedMilliseconds)ms")

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host 'all checks passed'
  exit 0
}
Write-Host ($script:failed.ToString() + ' checks FAILED')
exit 1