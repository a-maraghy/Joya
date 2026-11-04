//! The Claude Code process on this laptop: started with no console window, inside a Windows Job
//! Object that kills its whole process tree when the job is closed (lease end) -- or when this app
//! dies, because the app holds the job's only handle.

use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How to start a CLI found at `exe`: the program and the arguments that go before ours.
/// An npm `claude.cmd` is run as `node cli.js` when both are found (see claude::npm_cli_js).
pub fn plan(exe: &str, exists: &dyn Fn(&str) -> bool, path_env: &str, program_files: &str) -> (String, Vec<String>) {
    if let Some(js) = super::claude::npm_cli_js(exe) {
        if exists(&js) {
            if let Some(node) = super::claude::find(&super::claude::node_candidates(path_env, program_files), exists) {
                return (node, vec![js]);
            }
        }
    }
    (exe.to_string(), Vec::new())
}

fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// `claude --version` (15 s at most): Some("2.1.3"), None when it does not answer as Claude Code.
pub fn version(program: &str, pre: &[String]) -> Option<String> {
    let mut c = command(program);
    c.args(pre).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = c.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        let _ = tx.send(s);
    });
    let r = rx.recv_timeout(Duration::from_secs(15)).ok();
    let _ = child.kill();
    let _ = child.wait();
    super::claude::parse_version(&r?)
}

#[cfg(windows)]
struct Job(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}

#[cfg(windows)]
impl Job {
    fn new() -> Option<Job> {
        use windows::Win32::System::JobObjects::*;
        unsafe {
            let h = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const core::ffi::c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32).is_err() {
                let _ = windows::Win32::Foundation::CloseHandle(h);
                return None;
            }
            Some(Job(h))
        }
    }
    fn assign(&self, child: &Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        unsafe { windows::Win32::System::JobObjects::AssignProcessToJobObject(self.0, windows::Win32::Foundation::HANDLE(child.as_raw_handle())).is_ok() }
    }
    fn kill(self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

pub struct Proc {
    killed: AtomicBool,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    #[cfg(windows)]
    job: Mutex<Option<Job>>,
}

pub struct Spawned {
    pub proc: Proc,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

pub fn spawn(program: &str, args: &[String], cwd: &Path, env: &[(String, String)]) -> std::io::Result<Spawned> {
    #[cfg(windows)]
    let job = Job::new();
    let mut c = command(program);
    c.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn()?;
    // Into the job at once (the CLI takes far longer than this to start any child of its own).
    #[cfg(windows)]
    let job = match job {
        Some(j) if j.assign(&child) => Some(j),
        other => {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(j) = other {
                j.kill();
            }
            return Err(std::io::Error::other("could not put Claude Code in a job object"));
        }
    };
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| std::io::Error::other("no stderr"))?;
    Ok(Spawned {
        proc: Proc {
            killed: AtomicBool::new(false),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            #[cfg(windows)]
            job: Mutex::new(job),
        },
        stdout,
        stderr,
    })
}

impl Proc {
    /// One stream-json line to the CLI. False when it is gone.
    pub fn send(&self, v: &Value) -> bool {
        let mut g = self.stdin.lock().unwrap();
        let Some(s) = g.as_mut() else { return false };
        let mut line = v.to_string();
        line.push('\n');
        s.write_all(line.as_bytes()).and_then(|_| s.flush()).is_ok()
    }

    /// Kill the whole tree now (idempotent).
    pub fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.stdin.lock().unwrap().take();
        #[cfg(windows)]
        if let Some(j) = self.job.lock().unwrap().take() {
            j.kill();
        }
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }

    /// Put a helper process (PowerShell driving Office for the hands) in this session's Job Object,
    /// so the lease's end -- the stop key included -- kills it with the CLI. False when it could not be.
    pub fn contain(&self, child: &Child) -> bool {
        #[cfg(windows)]
        {
            match self.job.lock().unwrap().as_ref() {
                Some(j) => j.assign(child),
                None => false,
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            !self.killed()
        }
    }

    /// Killed by the app (lease end), not exited on its own.
    pub fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    /// Some(exit code) once it has exited (-1 when killed by a signal / unknown).
    pub fn exited(&self) -> Option<i32> {
        let mut g = self.child.lock().unwrap();
        let c = g.as_mut()?;
        match c.try_wait() {
            Ok(Some(st)) => Some(st.code().unwrap_or(-1)),
            Ok(None) => None,
            Err(_) => Some(-1),
        }
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.kill();
    }
}
