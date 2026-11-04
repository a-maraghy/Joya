# JOYA AI desktop app: Office edits and PDF export through the user's own Office (COM), for the
# laptop session's office_edit / pdf_export tools (hands/office_com.rs runs it, hidden, in the
# session's Job Object, with a time limit).
#
# Fixed code: it is never built from the model's words. The job (what to open, the edits, where to
# save) arrives as data -- base64 JSON -- and is only ever read as values.
#
# Safety, every time:
#   * macros never run: AutomationSecurity = msoAutomationSecurityForceDisable (3) before any file
#     is opened, events off (Excel), no alerts, links not updated;
#   * the original is opened READ-ONLY and never saved: the result is saved to a new file
#     (the app moves it into place afterwards, and only after the user approved an overwrite);
#   * Office instances started here are closed here; PowerPoint (one instance per user) is only
#     closed when it was not already running, and the user's settings changed for the run are put
#     back.
param([Parameter(Mandatory = $true)] $Job)

$ErrorActionPreference = 'Stop'
$notes = New-Object System.Collections.Generic.List[string]

function Norm([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '[\s\x07\x0b\r\n]', '')
}

function Esc-Find([string]$s) { return $s.Replace('^', '^^') }

function Lines([object]$v) {
  if ($null -eq $v) { return @() }
  return @($v | ForEach-Object { [string]$_ })
}

# ------------------------------------------------------------------------------------------ Word

function Word-Para($doc, [int]$i, [string]$expect) {
  $count = $doc.Paragraphs.Count
  if ($i -lt 1) { throw "There is no paragraph $i." }
  if ($i -le $count) {
    $p = $doc.Paragraphs.Item($i)
    if (($null -eq $expect) -or ((Norm $p.Range.Text) -eq (Norm $expect))) { return $p }
  }
  if ($null -ne $expect) {
    # Word counts paragraphs a little differently in some tables: find the one with that text nearest to $i.
    $best = $null; $dist = [int]::MaxValue
    for ($k = 1; $k -le $count; $k++) {
      $q = $doc.Paragraphs.Item($k)
      if ((Norm $q.Range.Text) -eq (Norm $expect)) {
        $d = [Math]::Abs($k - $i)
        if ($d -lt $dist) { $best = $q; $dist = $d }
      }
    }
    if ($null -ne $best) { return $best }
  }
  throw "Paragraph $i is not where office_read listed it; read the file again."
}

function Word-SetText($para, [string]$text) {
  $r = $para.Range
  if ($r.Text.EndsWith("`r") -or $r.Text.EndsWith([string][char]7)) { [void]$r.MoveEnd(1, -1) }
  $r.Text = ($text -replace "`r?`n", [string][char]11)
}

function Word-Edit($doc, $ops) {
  foreach ($op in $ops) {
    switch ($op.op) {
      'replace' {
        if ($op.find.Length -gt 255) { throw 'Word finds at most 255 characters at a time: use engine "file" for longer text.' }
        $n = 0
        $r = $doc.Content
        $f = $r.Find
        $f.ClearFormatting()
        $f.Text = ((Esc-Find $op.find) -replace "`r?`n", '^p')
        $f.MatchCase = [bool]$op.match_case
        $f.MatchWholeWord = $false
        $f.MatchWildcards = $false
        $f.Forward = $true
        $f.Wrap = 0
        $f.Format = $false
        while ($f.Execute()) {
          $r.Text = ($op.with -replace "`r?`n", [string][char]11)
          $n++
          if (-not $op.all -or $n -ge 10000) { break }
          [void]$r.Collapse(0)
        }
        $notes.Add("replaced `"$($op.find)`" $n time(s)")
      }
      'set_paragraph' {
        Word-SetText (Word-Para $doc $op.index $op.expect) $op.text
        $notes.Add("paragraph $($op.index) set")
      }
      'insert_paragraph' {
        if ($null -eq $op.after) {
          $doc.Content.InsertParagraphAfter()
          $np = $doc.Paragraphs.Last
          $where = 'at the end'
        } elseif ([int]$op.after -eq 0) {
          $doc.Paragraphs.Item(1).Range.InsertParagraphBefore()
          $np = $doc.Paragraphs.Item(1)
          $where = 'at the start'
        } else {
          $p = Word-Para $doc $op.after $op.expect
          $p.Range.InsertParagraphAfter()
          $np = $p.Next(1)
          $where = "after paragraph $($op.after)"
        }
        if ($null -ne $op.style_builtin) { $np.Range.Style = [int]$op.style_builtin } else { $np.Range.Style = -1 }
        Word-SetText $np $op.text
        $notes.Add("paragraph added $where")
      }
      'delete_paragraph' {
        (Word-Para $doc $op.index $op.expect).Range.Delete() | Out-Null
        $notes.Add("paragraph $($op.index) deleted")
      }
      default { throw "Not a Word edit: $($op.op)" }
    }
  }
}

# ----------------------------------------------------------------------------------------- Excel

function Excel-Sheet($wb, $name) {
  if ($null -eq $name -or "$name" -eq '') { return $wb.Worksheets.Item(1) }
  foreach ($ws in $wb.Worksheets) { if ($ws.Name -ieq "$name") { return $ws } }
  throw "There is no sheet `"$name`"."
}

function Excel-Put($cell, $v) {
  if ($null -eq $v) { [void]$cell.ClearContents(); return }
  if ($v -is [string] -and $v.StartsWith('=') -and $v.Length -gt 1) { $cell.Formula = $v; return }
  if ($v -is [string]) {
    # Text stays text (Excel would read "2026-10-20" or "00123" as a date or a number): the ' prefix.
    $cell.Value2 = "'" + $v
    return
  }
  if ($v -is [decimal]) { $v = [double]$v }
  $cell.Value2 = $v
}

function Excel-Edit($wb, $ops) {
  foreach ($op in $ops) {
    switch ($op.op) {
      'set_cells' {
        $ws = Excel-Sheet $wb $op.sheet
        $top = $ws.Range($op.cell)
        $n = 0
        $rows = @($op.values)
        for ($r = 0; $r -lt $rows.Count; $r++) {
          $cols = @($rows[$r])
          for ($c = 0; $c -lt $cols.Count; $c++) {
            Excel-Put ($top.Offset($r, $c)) $cols[$c]
            $n++
          }
        }
        $notes.Add("$n cell(s) set on `"$($ws.Name)`" from $($op.cell)")
      }
      'add_sheet' {
        foreach ($ws in $wb.Worksheets) { if ($ws.Name -ieq $op.name) { throw "There is already a sheet `"$($op.name)`"." } }
        $last = $wb.Worksheets.Item($wb.Worksheets.Count)
        $ws = $wb.Worksheets.Add([Type]::Missing, $last)
        $ws.Name = $op.name
        $rows = @($op.rows)
        for ($r = 0; $r -lt $rows.Count; $r++) {
          $cols = @($rows[$r])
          for ($c = 0; $c -lt $cols.Count; $c++) { Excel-Put ($ws.Cells.Item($r + 1, $c + 1)) $cols[$c] }
        }
        $notes.Add("sheet `"$($op.name)`" added")
      }
      default { throw "Not an Excel edit: $($op.op)" }
    }
  }
  $wb.Application.CalculateFull()
}

# ------------------------------------------------------------------------------------ PowerPoint

function Ppt-Body($slide) {
  foreach ($s in $slide.Shapes) {
    if ($s.Type -eq 14 -and $s.HasTextFrame) {
      $t = $s.PlaceholderFormat.Type
      if ($t -eq 2 -or $t -eq 7 -or $t -eq 4) { return $s }
    }
  }
  return $null
}

function Ppt-Edit($pres, $ops) {
  foreach ($op in $ops) {
    $count = $pres.Slides.Count
    switch ($op.op) {
      'replace' {
        $n = 0
        $from = 1; $to = $count
        if ($null -ne $op.slide) { $from = [int]$op.slide; $to = [int]$op.slide }
        if ($from -lt 1 -or $to -gt $count) { throw "There is no slide $($op.slide)." }
        $mc = 0; if ($op.match_case) { $mc = -1 }
        $with = ($op.with -replace "`r?`n", ' ')
        $ranges = New-Object System.Collections.Generic.List[object]
        for ($k = $from; $k -le $to; $k++) {
          foreach ($s in $pres.Slides.Item($k).Shapes) {
            if ($s.HasTextFrame) { $ranges.Add($s.TextFrame.TextRange) }
            elseif ($s.HasTable) {
              foreach ($row in $s.Table.Rows) { foreach ($cell in $row.Cells) { $ranges.Add($cell.Shape.TextFrame.TextRange) } }
            }
          }
        }
        :outer foreach ($tr in $ranges) {
          $after = 0
          while ($true) {
            # Replace(FindWhat, ReplaceWhat, After, MatchCase, WholeWords): the next one after $after, or nothing.
            $hit = $tr.Replace($op.find, $with, $after, $mc, 0)
            if ($null -eq $hit) { break }
            $n++
            if (-not $op.all -or $n -ge 10000) { break outer }
            $after = $hit.Start + $hit.Length - 1
          }
        }
        $notes.Add("replaced `"$($op.find)`" $n time(s)")
      }
      'set_slide' {
        if ($op.slide -lt 1 -or $op.slide -gt $count) { throw "There is no slide $($op.slide) (the deck has $count)." }
        $sl = $pres.Slides.Item([int]$op.slide)
        if ($null -ne $op.title) {
          if (-not $sl.Shapes.HasTitle) { throw "Slide $($op.slide) has no title box." }
          $sl.Shapes.Title.TextFrame.TextRange.Text = $op.title
        }
        if ($null -ne $op.bullets) {
          $b = Ppt-Body $sl
          if ($null -eq $b) { throw "Slide $($op.slide) has no text box for bullets." }
          $b.TextFrame.TextRange.Text = ((Lines $op.bullets) -join "`r")
        }
        if ($null -ne $op.notes) {
          try { $sl.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = $op.notes }
          catch { $notes.Add("notes of slide $($op.slide) not changed: no notes box") }
        }
        $notes.Add("slide $($op.slide) set")
      }
      'add_slide' {
        $pos = $count
        if ($null -ne $op.after) { $pos = [Math]::Min([int]$op.after, $count) }
        $layout = $null
        foreach ($l in $pres.SlideMaster.CustomLayouts) { if ($l.Name -match 'Title and Content') { $layout = $l; break } }
        if ($null -eq $layout) { if ($count -ge 1) { $layout = $pres.Slides.Item([Math]::Max($pos, 1)).CustomLayout } else { $layout = $pres.SlideMaster.CustomLayouts.Item(1) } }
        $sl = $pres.Slides.AddSlide($pos + 1, $layout)
        if ($sl.Shapes.HasTitle) { $sl.Shapes.Title.TextFrame.TextRange.Text = [string]$op.title }
        $b = Ppt-Body $sl
        if ($null -ne $b) { $b.TextFrame.TextRange.Text = ((Lines $op.bullets) -join "`r") }
        $notes.Add("slide added as slide $($pos + 1)")
      }
      'delete_slide' {
        if ($op.slide -lt 1 -or $op.slide -gt $count) { throw "There is no slide $($op.slide) (the deck has $count)." }
        if ($count -eq 1) { throw 'A deck keeps at least one slide.' }
        $pres.Slides.Item([int]$op.slide).Delete()
        $notes.Add("slide $($op.slide) deleted")
      }
      default { throw "Not a PowerPoint edit: $($op.op)" }
    }
  }
}

# ------------------------------------------------------------- the end of a take-over (close_started)
# inspect: the instance COM hands out for that app (GetActiveObject, the Running Object Table): its
# window handle and the full names of the files open in it. close_own / quit act on that instance
# only while its window handle is still the one inspect saw (never on another one): close_own closes
# the take-over's own files without saving and leaves the app running (the user has files open in
# it); quit closes them without saving, then quits the app (no save prompts).

function App-Name([string]$kind) {
  switch ($kind) { 'docx' { 'Word.Application' } 'xlsx' { 'Excel.Application' } 'pptx' { 'PowerPoint.Application' } default { throw "Unknown kind $kind" } }
}

function App-Hwnd($app, [string]$kind) {
  try {
    switch ($kind) {
      'docx' { if ($app.Windows.Count -gt 0) { return [int64]$app.Windows.Item(1).Hwnd } else { return [int64]0 } }
      'xlsx' { return [int64]$app.Hwnd }
      'pptx' { return [int64]$app.HWND }
    }
  } catch {}
  return [int64]0
}

function App-Files($app, [string]$kind) {
  $c = switch ($kind) { 'docx' { $app.Documents } 'xlsx' { $app.Workbooks } 'pptx' { $app.Presentations } }
  return @(@($c) | ForEach-Object { [string]$_.FullName })
}

function Close-Own($app, [string]$kind, $own) {
  $closed = 0
  $c = switch ($kind) { 'docx' { $app.Documents } 'xlsx' { $app.Workbooks } 'pptx' { $app.Presentations } }
  foreach ($f in @(@($c))) {
    if ($own -contains ([string]$f.FullName).ToLowerInvariant()) {
      switch ($kind) {
        'docx' { $f.Close(0) }
        'xlsx' { $f.Close($false) }
        'pptx' { $f.Saved = -1; $f.Close() }
      }
      $closed++
    }
  }
  return $closed
}

if (@('inspect', 'close_own', 'quit') -contains [string]$Job.action) {
  $r = @{ ok = $true; hwnd = [int64]0; files = @(); closed = 0 }
  $app = $null
  try {
    try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject((App-Name ([string]$Job.kind))) } catch { $app = $null }
    if ($null -ne $app) {
      $h = App-Hwnd $app ([string]$Job.kind)
      $r.hwnd = $h
      if ($Job.action -eq 'inspect') {
        $r.files = @(App-Files $app ([string]$Job.kind))
      } elseif (($h -eq 0) -or ($h -ne [int64]$Job.hwnd)) {
        $r = @{ ok = $false; error = 'Office is not the same instance any more.' }
      } else {
        $own = @(@($Job.own) | ForEach-Object { ([string]$_).ToLowerInvariant() })
        $r.closed = Close-Own $app ([string]$Job.kind) $own
        if ($Job.action -eq 'quit') {
          switch ([string]$Job.kind) {
            'docx' { $app.Quit(0) }
            'xlsx' { $app.DisplayAlerts = $false; $app.Quit() }
            'pptx' { $app.Quit() }
          }
        }
      }
    }
  } catch {
    $r = @{ ok = $false; error = ($_.Exception.Message -replace '\s+', ' ').Trim() }
  } finally {
    if ($null -ne $app) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {} }
  }
  $json = ConvertTo-Json -InputObject $r -Compress -Depth 4
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
  return
}

# ------------------------------------------------------------------------------------------ run

$app = $null; $file = $null; $restore = @{}
$result = @{ ok = $false }
try {
  $src = [string]$Job.src
  $out = [string]$Job.out
  $export = ($Job.action -eq 'export')
  switch ($Job.kind) {
    'docx' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument (a wrong one fails instead of asking)
      $file = $app.Documents.Open($src, $false, $true, $false, 'joya-no-password')
      if ($export) { $file.ExportAsFixedFormat($out, 17) }
      else { Word-Edit $file $Job.ops; $file.SaveAs2($out, 16) }
      $file.Close(0); $file = $null
      $app.Quit(0); $app = $null
    }
    'xlsx' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $app.AutomationSecurity = 3
      $app.EnableEvents = $false
      $restore.ask = $app.AskToUpdateLinks
      $app.AskToUpdateLinks = $false
      # FileName, UpdateLinks (0 = never), ReadOnly, Format, Password, WriteResPassword, IgnoreReadOnlyRecommended
      $file = $app.Workbooks.Open($src, 0, $true, 5, 'joya-no-password', 'joya-no-password', $true)
      if ($export) { $file.ExportAsFixedFormat(0, $out) }
      else { Excel-Edit $file $Job.ops; $file.SaveAs($out, 51) }
      $file.Close($false); $file = $null
      $app.AskToUpdateLinks = $restore.ask
      $app.Quit(); $app = $null
    }
    'pptx' {
      $wasRunning = [bool](Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
      $app = New-Object -ComObject PowerPoint.Application
      $restore.sec = $app.AutomationSecurity
      $restore.running = $wasRunning
      $app.AutomationSecurity = 3
      # FileName, ReadOnly, Untitled, WithWindow
      $file = $app.Presentations.Open($src, -1, 0, 0)
      if ($export) { $file.SaveAs($out, 32) }
      else { Ppt-Edit $file $Job.ops; $file.SaveAs($out, 24) }
      $file.Close(); $file = $null
    }
    default { throw "Unknown kind $($Job.kind)" }
  }
  $result = @{ ok = $true; notes = @($notes) }
} catch {
  $result = @{ ok = $false; error = ($_.Exception.Message -replace '\s+', ' ').Trim(); notes = @($notes) }
} finally {
  if ($null -ne $file) { try { if ($Job.kind -eq 'docx') { $file.Close(0) } elseif ($Job.kind -eq 'xlsx') { $file.Close($false) } else { $file.Close() } } catch {} }
  if ($null -ne $app) {
    try {
      if ($Job.kind -eq 'pptx') {
        if ($null -ne $restore.sec) { $app.AutomationSecurity = $restore.sec }
        if (-not $restore.running -and $app.Presentations.Count -eq 0) { $app.Quit() }
      } elseif ($Job.kind -eq 'xlsx') {
        if ($null -ne $restore.ask) { $app.AskToUpdateLinks = $restore.ask }
        $app.Quit()
      } else { $app.Quit(0) }
    } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
  }
}
$json = ConvertTo-Json -InputObject $result -Compress -Depth 4
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
