//! The Office engine: the user's own Word, Excel or PowerPoint driven through COM by a fixed
//! PowerShell script (office.ps1), for office_edit (when Office is installed) and pdf_export.
//!
//! How it runs: `powershell.exe -NoProfile -NonInteractive -EncodedCommand <bootstrap>` with no
//! window, put in the control session's Job Object (the lease's end, or the stop key, kills it with
//! everything else) and given a time limit. The bootstrap reads two base64 lines from stdin -- the
//! script and the job -- so nothing the model wrote is ever part of a command line or of the code:
//! the job is data (ConvertFrom-Json). The answer comes back as one base64 JSON line.
//!
//! Pure parts (the job, the payload, the answer, the paragraphs' expected texts) are unit-tested in
//! core-tests; the process and the registry check are Windows only.

use base64::Engine;
use serde_json::{json, Value};

use super::ooxml::{self, Op};
use super::paths::Office;

/// office.ps1, as shipped in the app (never built from input).
pub const SCRIPT: &str = include_str!("office.ps1");
/// Office gets this long for one job, then the job is killed.
pub const TIMEOUT_SECS: u64 = 180;

/// The bootstrap the command line carries: reads the script and the job from stdin and runs it.
pub const BOOTSTRAP: &str = "$ErrorActionPreference='Stop';$a=[Console]::In.ReadLine();$b=[Console]::In.ReadLine();$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a));$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))|ConvertFrom-Json;& ([ScriptBlock]::Create($s)) -Job $j";

/// -EncodedCommand's argument: base64 of the UTF-16LE text.
pub fn encoded_command(cmd: &str) -> String {
    let utf16: Vec<u8> = cmd.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

pub fn args() -> Vec<String> {
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"].iter().map(|s| s.to_string()).chain(std::iter::once(encoded_command(BOOTSTRAP))).collect()
}

/// The job for office.ps1. `action` "edit" (with ops) or "export" (to PDF).
pub fn job(action: &str, kind: Office, src: &str, out: &str, ops: Option<Value>) -> Value {
    json!({ "action": action, "kind": kind.ext(), "src": src, "out": out, "ops": ops.unwrap_or(json!([])) })
}

/// What goes to stdin: the script and the job, each one base64 line.
pub fn stdin_payload(job: &Value) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("{}\n{}\n", b.encode(SCRIPT.as_bytes()), b.encode(job.to_string().as_bytes()))
}

/// office.ps1's answer as JSON (the one base64 line it writes).
pub fn parse_value(stdout: &str) -> Result<Value, String> {
    let line = stdout.trim();
    let bytes = base64::engine::general_purpose::STANDARD.decode(line.lines().last().unwrap_or("").trim()).map_err(|_| "Office did not answer (PowerShell could not run the Office script).".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Office's answer could not be read.".to_string())
}

/// office.ps1's answer -> its notes, or the error it gave.
pub fn parse_answer(stdout: &str) -> Result<Vec<String>, String> {
    let v = parse_value(stdout)?;
    let notes: Vec<String> = match v.get("notes") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    };
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(notes)
    } else {
        let e = v.get("error").and_then(Value::as_str).unwrap_or("Office reported an error.");
        Err(format!("Office: {}", e.chars().take(400).collect::<String>()))
    }
}

/// The edits for office.ps1, each Word paragraph edit carrying the text office_read showed for that
/// paragraph at that point (`expect`): Word counts paragraphs in tables a little differently, so the
/// script checks the paragraph by its text and finds the right one when the number is off. The
/// texts come from running the same edits on a copy with the file engine.
pub fn ops_for_office(kind: Office, original: &[u8], ops: &[Op]) -> Value {
    let mut out = ooxml::ops_json(ops);
    if kind != Office::Docx {
        return out;
    }
    let mut cur = original.to_vec();
    for (i, op) in ops.iter().enumerate() {
        let texts = ooxml::Package::open(&cur).map(|p| ooxml::docx_paragraph_texts(&p)).unwrap_or_default();
        let at = match op {
            Op::SetParagraph { index, .. } | Op::DeleteParagraph { index } => Some(*index),
            Op::InsertParagraph { after: Some(n), .. } if *n > 0 => Some(*n),
            _ => None,
        };
        if let Some(n) = at {
            if let Some(t) = texts.get(n - 1) {
                out[i]["expect"] = json!(t);
            }
        }
        match ooxml::edit(kind, &cur, std::slice::from_ref(op)) {
            Ok((next, _)) => cur = next,
            Err(_) => break, // the rest go by number only
        }
    }
    out
}

/* ------------------------------------------------------------------ Windows: is it installed, run it */

/// Is the Office app for this kind installed (its COM class registered)?
#[cfg(windows)]
pub fn installed(kind: Office) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
    let prog = match kind {
        Office::Docx => "Word.Application\\CLSID",
        Office::Xlsx => "Excel.Application\\CLSID",
        Office::Pptx => "PowerPoint.Application\\CLSID",
        Office::Pdf => return false,
    };
    let w: Vec<u16> = prog.encode_utf16().chain(std::iter::once(0)).collect();
    let mut h = HKEY::default();
    unsafe {
        let ok = RegOpenKeyExW(HKEY_CLASSES_ROOT, PCWSTR(w.as_ptr()), Some(0), KEY_READ, &mut h).is_ok();
        if ok {
            let _ = RegCloseKey(h);
        }
        ok
    }
}

#[cfg(not(windows))]
pub fn installed(_kind: Office) -> bool {
    false
}

/// Run one job. `contain` puts the PowerShell process in the session's Job Object (false = refused).
/// What Office was running before is noted, so an app this job starts (and leaves behind) is closed at
/// the end of the take-over; the files it opens and writes are the take-over's own.
#[cfg(windows)]
pub fn run(job: &Value, contain: &dyn Fn(&std::process::Child) -> bool) -> Result<Vec<String>, String> {
    struct Done(u64);
    impl Drop for Done {
        fn drop(&mut self) {
            job_done(self.0, &office_processes());
        }
    }
    let _done = Done(job_begins(office_processes(), job_files(job)));
    let (out, err) = run_script(job, contain, TIMEOUT_SECS)?;
    parse_answer(&out).map_err(|e| {
        let said = err.lines().find(|l| !l.trim().is_empty()).map(|l| l.chars().take(200).collect::<String>());
        match said {
            Some(s) if e.starts_with("Office did not answer") => format!("{e} ({s})"),
            _ => e,
        }
    })
}

/// office.ps1 with one job: (stdout, stderr), or why it did not finish.
#[cfg(windows)]
fn run_script(job: &Value, contain: &dyn Fn(&std::process::Child) -> bool, timeout_secs: u64) -> Result<(String, String), String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps = format!("{sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let mut child = Command::new(&ps)
        .args(args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("PowerShell could not start: {e}"))?;
    if !contain(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The Office job could not be tied to this control session, so it was not run.".into());
    }
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(stdin_payload(job).as_bytes());
    }
    let mut so = child.stdout.take().ok_or("no stdout")?;
    let mut se = child.stderr.take().ok_or("no stderr")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = so.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = se.read_to_string(&mut s);
        s
    });
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() > Duration::from_secs(timeout_secs) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Office did not finish within {timeout_secs} seconds (it may be showing a message on screen); the job was stopped."));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    Ok((out, err))
}

#[cfg(not(windows))]
pub fn run(_job: &Value, _contain: &dyn Fn(&std::process::Child) -> bool) -> Result<Vec<String>, String> {
    Err("Office is only used on Windows.".into())
}

/* ------------------------------------------------- the Office apps a take-over started, closed at its end */

/// One running Office process: pid + creation time (a reused pid never matches), its exe and its
/// parent's exe (lower case).
#[derive(Clone, Debug, PartialEq)]
pub struct OfficeProc {
    pub pid: u32,
    pub created: u64,
    pub exe: String,
    pub parent_exe: String,
}

/// The Office apps the hands drive through COM.
pub const OFFICE_EXES: [&str; 3] = ["winword.exe", "excel.exe", "powerpnt.exe"];

/// COM starts an automation instance from DcomLaunch (svchost.exe): one the user opened has Explorer,
/// a shortcut or Outlook as its parent, so it is never taken for the take-over's.
fn com_started(p: &OfficeProc) -> bool {
    p.parent_exe.eq_ignore_ascii_case("svchost.exe")
}

/// The Office processes that appeared between `before` and `now` and were started by COM: the job's.
/// An instance already running before the job (same pid and creation time) is never one of them.
pub fn started_between(before: &[OfficeProc], now: &[OfficeProc]) -> Vec<OfficeProc> {
    now.iter()
        .filter(|p| OFFICE_EXES.contains(&p.exe.as_str()) && com_started(p))
        .filter(|p| !before.iter().any(|b| b.pid == p.pid && b.created == p.created))
        .cloned()
        .collect()
}

/// What to close at the end: the take-over's instances still running (pid AND creation time match),
/// plus any a job still in flight started since its snapshot. Each pid once.
pub fn to_close(owned: &[OfficeProc], open_jobs: &[Vec<OfficeProc>], now: &[OfficeProc]) -> Vec<OfficeProc> {
    let mut out: Vec<OfficeProc> = Vec::new();
    let mut add = |p: &OfficeProc| {
        if !out.iter().any(|o| o.pid == p.pid) {
            out.push(p.clone());
        }
    };
    for p in now.iter().filter(|p| owned.iter().any(|o| o.pid == p.pid && o.created == p.created)) {
        add(p);
    }
    for before in open_jobs {
        for p in started_between(before, now) {
            add(&p);
        }
    }
    out
}

struct Started {
    owned: Vec<OfficeProc>,
    open_jobs: Vec<(u64, Vec<OfficeProc>)>,
    files: Vec<String>,
    next: u64,
}

static STARTED: std::sync::Mutex<Started> = std::sync::Mutex::new(Started { owned: Vec::new(), open_jobs: Vec::new(), files: Vec::new(), next: 0 });

/// A path as Office shows it (FullName), ready to compare: trimmed, backslashes, lower case.
pub fn norm_file(p: &str) -> String {
    p.trim().replace('/', "\\").to_lowercase()
}

/// The files a job opens and writes (`src`, and `out`: the temp file it saves to): the take-over's own.
pub fn job_files(job: &Value) -> Vec<String> {
    ["src", "out"].iter().filter_map(|k| job.get(*k).and_then(Value::as_str)).filter(|s| !s.trim().is_empty()).map(norm_file).collect()
}

/// Before a job: remember what was running and the files the job will open. Returns the job's ticket
/// for `job_done`.
pub fn job_begins(before: Vec<OfficeProc>, files: Vec<String>) -> u64 {
    let mut s = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    s.next += 1;
    let t = s.next;
    s.open_jobs.push((t, before));
    for f in files {
        if !s.files.contains(&f) {
            s.files.push(f);
        }
    }
    t
}

/// After a job: whatever it started and left running is the take-over's (normally none: the script quits
/// the app it started; one left behind by an error or a timeout is counted here).
pub fn job_done(ticket: u64, now: &[OfficeProc]) {
    let mut s = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = s.open_jobs.iter().position(|(t, _)| *t == ticket) {
        let (_, before) = s.open_jobs.remove(i);
        for p in started_between(&before, now) {
            if !s.owned.iter().any(|o| o.pid == p.pid && o.created == p.created) {
                s.owned.push(p);
            }
        }
    }
}

/// At the end of a take-over: the Office processes it started that still run, and the files it opened.
#[derive(Debug, PartialEq)]
pub struct EndOfTakeOver {
    pub close: Vec<OfficeProc>,
    pub own_files: Vec<String>,
}

/// The end of a take-over (stop key, Stop, expiry, link lost): pick what to close from `now` and forget
/// the take-over's lists.
pub fn end_of_take_over(now: &[OfficeProc]) -> EndOfTakeOver {
    let mut s = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    let jobs: Vec<Vec<OfficeProc>> = s.open_jobs.iter().map(|(_, b)| b.clone()).collect();
    let close = to_close(&s.owned, &jobs, now);
    let own_files = std::mem::take(&mut s.files);
    s.owned.clear();
    s.open_jobs.clear();
    EndOfTakeOver { close, own_files }
}

/// How long a quit or a close request gets before the process is force-closed.
pub const QUIT_WAIT_MS: u32 = 5000;

/// What to do with one Office process the take-over started, so the user's own work is never lost.
#[derive(Debug, PartialEq)]
pub enum EndPlan {
    /// The user has files open in it (PowerPoint is one instance per user; a Word / Excel file opened
    /// into it): close only the take-over's own files, without saving (`own_open` of them are open), and
    /// leave the app running.
    CloseOwnKeepApp { own_open: usize },
    /// COM cannot reach it, but it has a window on screen the user may be using: leave it running.
    Keep,
    /// Only the take-over's files (or none) are open: quit it through COM (no save prompts for its
    /// files), force-close it if it is still running after QUIT_WAIT_MS.
    Quit,
    /// COM cannot reach it and nothing of it is on screen (a hidden automation instance): ask its windows
    /// to close, force-close it if it is still running after QUIT_WAIT_MS.
    CloseWindows,
}

/// The files open in it that are not the take-over's.
pub fn others_files(open: &[String], own: &[String]) -> Vec<String> {
    open.iter().filter(|f| !own.contains(&norm_file(f))).cloned().collect()
}

/// `com_files`: the files open in that process, when COM reached it (None = it could not tell);
/// `visible`: it has a visible window.
pub fn end_plan(com_files: Option<&[String]>, own: &[String], visible: bool) -> EndPlan {
    match com_files {
        Some(open) if !others_files(open, own).is_empty() => EndPlan::CloseOwnKeepApp { own_open: open.len() - others_files(open, own).len() },
        Some(_) => EndPlan::Quit,
        None if visible => EndPlan::Keep,
        None => EndPlan::CloseWindows,
    }
}

/// The app's name for the log.
pub fn app_name(exe: &str) -> &'static str {
    match exe {
        "winword.exe" => "Word",
        "excel.exe" => "Excel",
        "powerpnt.exe" => "PowerPoint",
        _ => "Office",
    }
}

/// The job kind office.ps1 knows the app by.
pub fn kind_of_exe(exe: &str) -> &'static str {
    match exe {
        "winword.exe" => "docx",
        "excel.exe" => "xlsx",
        _ => "pptx",
    }
}

/// The Office processes running now.
#[cfg(windows)]
pub fn office_processes() -> Vec<OfficeProc> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let mut all: Vec<(u32, u32, String)> = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return Vec::new() };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                all.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..n]).to_ascii_lowercase()));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    let mut out = Vec::new();
    for (pid, ppid, exe) in &all {
        if !OFFICE_EXES.contains(&exe.as_str()) {
            continue;
        }
        let Some(created) = creation_time(*pid) else { continue };
        let parent_exe = all.iter().find(|(p, _, _)| p == ppid).map(|(_, _, e)| e.clone()).unwrap_or_default();
        out.push(OfficeProc { pid: *pid, created, exe: exe.clone(), parent_exe });
    }
    out
}

#[cfg(windows)]
fn times_of(h: windows::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;
    let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).ok()? };
    Some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
}

#[cfg(windows)]
fn creation_time(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let t = times_of(h);
        let _ = CloseHandle(h);
        t
    }
}

#[cfg(not(windows))]
pub fn office_processes() -> Vec<OfficeProc> {
    Vec::new()
}

/// office.ps1's end-of-take-over actions (inspect / close_own / quit), outside the Job Object (the
/// take-over is over), 30 s at most: its answer, or why there is none.
#[cfg(windows)]
fn ask_office(job: &Value) -> Result<Value, String> {
    let (out, _) = run_script(job, &|_| true, 30)?;
    let v = parse_value(&out)?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("Office reported an error.").chars().take(200).collect())
    }
}

/// The top-level windows of a process, and whether each is visible.
#[cfg(windows)]
fn windows_of(pid: u32) -> Vec<(windows::Win32::Foundation::HWND, bool)> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};
    struct Acc {
        pid: u32,
        out: Vec<(HWND, bool)>,
    }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> windows::core::BOOL {
        let acc = &mut *(l.0 as *mut Acc);
        let mut p = 0u32;
        GetWindowThreadProcessId(h, Some(&mut p));
        if p == acc.pid {
            acc.out.push((h, IsWindowVisible(h).as_bool()));
        }
        windows::core::BOOL(1)
    }
    let mut acc = Acc { pid, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut acc as *mut Acc as isize));
    }
    acc.out
}

#[cfg(windows)]
fn window_pid(hwnd: i64) -> u32 {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut p = 0u32;
    unsafe {
        GetWindowThreadProcessId(HWND(hwnd as isize as *mut core::ffi::c_void), Some(&mut p));
    }
    p
}

/// Wait up to `ms` for that process (the same one: pid and creation time) to end. True = it is gone.
#[cfg(windows)]
fn ends_within(p: &OfficeProc, ms: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, p.pid) else { return true };
        let gone = times_of(h) != Some(p.created) || WaitForSingleObject(h, ms) == WAIT_OBJECT_0;
        let _ = CloseHandle(h);
        gone
    }
}

/// Force-close that process (the same one: pid and creation time).
#[cfg(windows)]
fn terminate(p: &OfficeProc) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, p.pid) else { return false };
        let ok = times_of(h) == Some(p.created) && TerminateProcess(h, 1).is_ok();
        let _ = CloseHandle(h);
        ok
    }
}

/// Wait for it to end after a quit / close request; force-close it if it is still there. The log line's end.
#[cfg(windows)]
fn finish_off(p: &OfficeProc) -> String {
    if ends_within(p, QUIT_WAIT_MS) {
        "it closed".into()
    } else if terminate(p) {
        format!("it was still running after {} s, so it was force-closed", QUIT_WAIT_MS / 1000)
    } else {
        format!("it was still running after {} s and could not be force-closed", QUIT_WAIT_MS / 1000)
    }
}

/// The end of a take-over: the Office apps it started are closed, the user's own work never lost
/// (EndPlan). Instances that were running before it are not touched. One log line per app.
#[cfg(windows)]
pub fn close_started() -> Vec<String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    let end = end_of_take_over(&office_processes());
    let mut log = Vec::new();
    // What COM hands out for each app with a process to close: the pid behind its window, its window
    // handle (close_own / quit check it again) and the files open in it.
    let mut com: Vec<(u32, i64, Vec<String>)> = Vec::new();
    for exe in OFFICE_EXES {
        if !end.close.iter().any(|p| p.exe == exe) {
            continue;
        }
        if let Ok(v) = ask_office(&json!({ "action": "inspect", "kind": kind_of_exe(exe) })) {
            let hwnd = v.get("hwnd").and_then(Value::as_i64).unwrap_or(0);
            if hwnd != 0 {
                let files = v.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                com.push((window_pid(hwnd), hwnd, files));
            }
        }
    }
    for p in &end.close {
        let name = app_name(&p.exe);
        let reach = com.iter().find(|c| c.0 == p.pid);
        let wins = windows_of(p.pid);
        let plan = end_plan(reach.map(|c| c.2.as_slice()), &end.own_files, wins.iter().any(|w| w.1));
        let act = |action: &str| ask_office(&json!({ "action": action, "kind": kind_of_exe(&p.exe), "hwnd": reach.map(|c| c.1).unwrap_or(0), "own": end.own_files }));
        let line = match plan {
            EndPlan::CloseOwnKeepApp { own_open: 0 } => format!("{name} (pid {}): the user has files open in it, so it was left running", p.pid),
            EndPlan::CloseOwnKeepApp { .. } => match act("close_own") {
                Ok(v) => format!("{name} (pid {}): the user has files open in it, so it was left running; {} of the take-over's file(s) closed without saving", p.pid, v.get("closed").and_then(Value::as_u64).unwrap_or(0)),
                Err(e) => format!("{name} (pid {}): the user has files open in it, so it was left running; the take-over's files could not be closed ({e})", p.pid),
            },
            EndPlan::Keep => format!("{name} (pid {}): COM could not reach it and it has a window on screen the user may be using, so it was left running", p.pid),
            EndPlan::Quit => match act("quit") {
                Ok(_) => format!("{name} (pid {}): asked to quit (the take-over's files closed without saving); {}", p.pid, finish_off(p)),
                Err(e) => format!("{name} (pid {}): could not be asked to quit ({e}); {}", p.pid, finish_off(p)),
            },
            EndPlan::CloseWindows => {
                for (h, _) in &wins {
                    unsafe {
                        let _ = PostMessageW(Some(*h), WM_CLOSE, WPARAM(0), LPARAM(0));
                    }
                }
                format!("{name} (pid {}): a hidden instance COM could not reach; its windows were asked to close; {}", p.pid, finish_off(p))
            }
        };
        log.push(line);
    }
    log
}

#[cfg(not(windows))]
pub fn close_started() -> Vec<String> {
    let _ = end_of_take_over(&[]);
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hands::docs;

    #[test]
    fn the_script_is_fixed_and_safe() {
        // Macros never run; originals open read-only; the user's instance is not closed; no Invoke-Expression.
        for must in ["AutomationSecurity = 3", "EnableEvents = $false", "Documents.Open($src, $false, $true", "Workbooks.Open($src, 0, $true", "Presentations.Open($src, -1, 0, 0)", "-not $restore.running", "ExportAsFixedFormat($out, 17)", "SaveAs($out, 32)"] {
            assert!(SCRIPT.contains(must), "missing: {must}");
        }
        for never in ["Invoke-Expression", "iex ", "Start-Process", "RunAutoMacros", ".Run(", "Add-Type", "DownloadString", "Invoke-WebRequest"] {
            assert!(!SCRIPT.contains(never), "must not: {never}");
        }
        assert!(SCRIPT.len() < 24_000);
    }

    #[test]
    fn command_line_and_payload() {
        let a = args();
        assert_eq!(&a[..6], &["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
        let decoded = base64::engine::general_purpose::STANDARD.decode(&a[6]).unwrap();
        let u16s: Vec<u16> = decoded.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&u16s).unwrap(), BOOTSTRAP);
        assert!(a[6].len() < 2000, "the command line stays short");
        let j = job("edit", Office::Docx, "C:\\a\\R.docx", "C:\\a\\R (edited).docx", Some(json!([{"op": "replace", "find": "'; Remove-Item C:\\ -Recurse; '", "with": "x"}])));
        let p = stdin_payload(&j);
        let lines: Vec<&str> = p.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c))), "only base64: nothing the model wrote reaches PowerShell as code");
        let back: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(lines[1]).unwrap()).unwrap();
        assert_eq!(back, j);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(lines[0]).unwrap(), SCRIPT.as_bytes());
    }

    #[test]
    fn answers() {
        let enc = |v: Value| base64::engine::general_purpose::STANDARD.encode(v.to_string());
        assert_eq!(parse_answer(&enc(json!({"ok": true, "notes": ["a", "b"]}))).unwrap(), vec!["a", "b"]);
        assert_eq!(parse_answer(&enc(json!({"ok": true, "notes": "one"}))).unwrap(), vec!["one"]);
        assert_eq!(parse_answer(&enc(json!({"ok": false, "error": "There is no slide 9."}))).unwrap_err(), "Office: There is no slide 9.");
        assert!(parse_answer("garbage!").unwrap_err().contains("did not answer"));
        assert!(parse_answer("").is_err());
    }

    fn proc(pid: u32, created: u64, exe: &str, parent: &str) -> OfficeProc {
        OfficeProc { pid, created, exe: exe.into(), parent_exe: parent.into() }
    }

    #[test]
    fn only_the_office_apps_a_job_started_are_its_own() {
        let users_word = proc(10, 100, "winword.exe", "explorer.exe");
        let users_excel_com = proc(11, 101, "excel.exe", "svchost.exe"); // automation instance, but running before
        let before = vec![users_word.clone(), users_excel_com.clone()];
        let jobs_word = proc(20, 200, "winword.exe", "svchost.exe");
        let opened_by_user_meanwhile = proc(21, 201, "powerpnt.exe", "explorer.exe");
        let notepad = proc(22, 202, "notepad.exe", "svchost.exe");
        let reused_pid = proc(10, 999, "winword.exe", "svchost.exe"); // pid 10 again, a new process
        let now = vec![users_word.clone(), users_excel_com.clone(), jobs_word.clone(), opened_by_user_meanwhile, notepad, reused_pid.clone()];
        let got = started_between(&before, &now);
        assert_eq!(got, vec![jobs_word.clone(), reused_pid.clone()]);
        // At the end: an owned instance that has since gone is not closed; one whose pid was reused is not ours.
        let owned = vec![jobs_word.clone(), proc(30, 300, "excel.exe", "svchost.exe")];
        let later = vec![users_word.clone(), users_excel_com.clone(), jobs_word.clone(), proc(30, 301, "excel.exe", "svchost.exe")];
        assert_eq!(to_close(&owned, &[], &later), vec![jobs_word.clone()]);
        // A job still running at the stop: what it started since its snapshot goes too, each pid once.
        let flying = proc(40, 400, "powerpnt.exe", "svchost.exe");
        let mut later2 = later.clone();
        later2.push(flying.clone());
        assert_eq!(to_close(&owned, &[later.clone(), later.clone()], &later2), vec![jobs_word.clone(), flying.clone()]);
        assert!(to_close(&owned, &[before.clone()], &before).is_empty(), "the user's own Office is never closed");
    }

    #[test]
    fn a_take_over_remembers_and_forgets_its_office_apps() {
        let users = proc(10, 100, "winword.exe", "explorer.exe");
        let j1 = job("edit", Office::Xlsx, "C:\\Users\\A\\Documents\\Budget.xlsx", "C:/Users/A/Documents/~joya-1a2b.xlsx", None);
        let t1 = job_begins(vec![users.clone()], job_files(&j1));
        let left = proc(50, 500, "excel.exe", "svchost.exe");
        job_done(t1, &[users.clone(), left.clone()]); // an error left Excel running
        let j2 = job("export", Office::Pptx, "C:\\Users\\A\\Documents\\Q3.pptx", "C:\\Users\\A\\Documents\\~joya-3c4d.pdf", None);
        let t2 = job_begins(vec![users.clone(), left.clone()], job_files(&j2));
        let flying = proc(51, 510, "powerpnt.exe", "svchost.exe");
        // The stop comes while job 2 runs.
        let now = vec![users.clone(), left.clone(), flying.clone()];
        let end = end_of_take_over(&now);
        assert_eq!(end.close, vec![left, flying]);
        assert_eq!(
            end.own_files,
            vec!["c:\\users\\a\\documents\\budget.xlsx", "c:\\users\\a\\documents\\~joya-1a2b.xlsx", "c:\\users\\a\\documents\\q3.pptx", "c:\\users\\a\\documents\\~joya-3c4d.pdf"]
        );
        job_done(t2, &now); // finishing after the end adds nothing
        let again = end_of_take_over(&now);
        assert!(again.close.is_empty() && again.own_files.is_empty(), "the lists are forgotten at the end");
    }

    #[test]
    fn the_users_own_work_is_never_lost() {
        let own = vec![norm_file("C:\\Users\\A\\Documents\\Q3.pptx"), norm_file("C:\\Users\\A\\Documents\\~joya-3c4d.pptx")];
        let files = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // PowerPoint the take-over started, and the user opened a deck of their own into it: keep it,
        // close only the take-over's (one of its two files is still open; Office spells it its own way).
        let mixed = files(&["C:\\Users\\A\\Documents\\Q3.PPTX", "D:\\Talks\\Mine.pptx"]);
        assert_eq!(end_plan(Some(&mixed), &own, true), EndPlan::CloseOwnKeepApp { own_open: 1 });
        assert_eq!(others_files(&mixed, &own), files(&["D:\\Talks\\Mine.pptx"]));
        // Only the user's file in it: keep it, nothing of the take-over's to close.
        assert_eq!(end_plan(Some(&files(&["D:\\Talks\\Mine.pptx"])), &own, true), EndPlan::CloseOwnKeepApp { own_open: 0 });
        // Only the take-over's files, or none: quit (then force-close after QUIT_WAIT_MS).
        assert_eq!(end_plan(Some(&files(&["c:/users/a/documents/~joya-3c4d.pptx"])), &own, false), EndPlan::Quit);
        assert_eq!(end_plan(Some(&[]), &own, true), EndPlan::Quit);
        // COM could not tell: a window on screen may be the user's -> leave it; a hidden instance -> close it.
        assert_eq!(end_plan(None, &own, true), EndPlan::Keep);
        assert_eq!(end_plan(None, &own, false), EndPlan::CloseWindows);
        assert_eq!(QUIT_WAIT_MS, 5000);
        assert_eq!((app_name("winword.exe"), app_name("excel.exe"), app_name("powerpnt.exe")), ("Word", "Excel", "PowerPoint"));
        assert_eq!((kind_of_exe("winword.exe"), kind_of_exe("excel.exe"), kind_of_exe("powerpnt.exe")), ("docx", "xlsx", "pptx"));
        assert_eq!(job_files(&json!({"action": "inspect", "kind": "docx"})), Vec::<String>::new());
    }

    #[test]
    fn the_end_actions_are_in_the_fixed_script() {
        for must in ["'inspect', 'close_own', 'quit'", "GetActiveObject", "$f.Close(0)", "$f.Close($false)", "$f.Saved = -1", "($h -ne [int64]$Job.hwnd)", "$app.Quit(0)"] {
            assert!(SCRIPT.contains(must), "missing: {must}");
        }
    }

    #[test]
    fn word_edits_carry_the_expected_text() {
        let blocks = docs::parse_blocks(Some(&json!(["One", "Two", "Three"]))).unwrap();
        let f = docs::build_docx("T", &blocks).unwrap();
        let ops = ooxml::parse_ops(Office::Docx, &json!([{"insert_paragraph": {"text": "Zero", "after": 0}}, {"set_paragraph": {"index": 3, "text": "2"}}, {"delete_paragraph": {"index": 4}}, {"replace": {"find": "One", "with": "1"}}])).unwrap();
        let o = ops_for_office(Office::Docx, &f, &ops);
        let texts = ooxml::docx_paragraph_texts(&ooxml::Package::open(&f).unwrap());
        // After "Zero" goes in at the start, paragraph 3 is the original paragraph 2 (index 1 before the edit).
        assert_eq!(o[1]["expect"], json!(texts[1]), "{o}");
        assert_eq!(o[0].get("expect"), None, "inserting at the start names no paragraph");
        assert!(o[2]["expect"].is_string());
        assert_eq!(o[3]["op"], "replace");
        let x = ops_for_office(Office::Xlsx, b"", &ooxml::parse_ops(Office::Xlsx, &json!([{"set_cells": {"cell": "A1", "values": [[1]]}}])).unwrap());
        assert_eq!(x[0]["cell"], "A1");
    }
}
