//! Where the Office and PDF tools may read and write (pure; unit-tested in core-tests).
//!
//! Only the user's own folders: Documents, Desktop, Downloads, OneDrive (each OneDrive the
//! environment names), and the folders the user added on the Computers page in Joya. Paths are
//! Windows paths, handled as strings here so the rules are the same on the Linux build box:
//! "C:/Users/a/x", "~\x" and "%USERPROFILE%\x" are read as a person would, `..` is resolved before
//! the check (it can never climb out of a root), and network (UNC) or device paths
//! (`\\?\`, `\\.\`) are never allowed. The tool layer checks again after resolving links on disk.
//!
//! Writing: a tool never replaces an existing file on its own. By default it writes a new copy next
//! to the original ("Report (edited).docx", then " (2)" ...); replacing the original, or writing
//! over any existing file, is the user's call (an approval card, Windows Hello).

/// One allowed folder: its label (for messages) and its normalised path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    pub label: String,
    pub path: String,
}

/// The allowed folders from the profile and the environment, plus the user's own additions.
/// `onedrive` = the values of %OneDrive%, %OneDriveConsumer%, %OneDriveCommercial% (any may be empty).
pub fn roots(documents: &str, desktop: &str, downloads: &str, onedrive: &[&str], extra: &[String]) -> Vec<Root> {
    let mut out: Vec<Root> = Vec::new();
    let mut add = |label: &str, p: &str| {
        let Some(n) = absolute(p) else { return };
        if n.len() <= 3 || out.iter().any(|r| r.path.eq_ignore_ascii_case(&n)) {
            return; // never a whole drive
        }
        out.push(Root { label: label.to_string(), path: n });
    };
    add("Documents", documents);
    add("Desktop", desktop);
    add("Downloads", downloads);
    for o in onedrive {
        add("OneDrive", o);
    }
    for e in extra {
        if folder_ok(e).is_ok() {
            add("your folder", e);
        }
    }
    out
}

/// "C:/a\\b/../c" -> Some("C:\\a\\c"); None unless it is an absolute drive path (no UNC, no device paths).
pub fn absolute(p: &str) -> Option<String> {
    let s = p.trim().trim_matches('"').replace('/', "\\");
    if s.starts_with("\\\\") || s.contains('\0') || s.chars().any(|c| c.is_control()) {
        return None; // \\server\share, \\?\..., \\.\...
    }
    let b = s.as_bytes();
    if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
        return None;
    }
    if b.len() > 2 && b[2] != b'\\' {
        return None; // "C:foo" is relative to that drive's current folder
    }
    let drive = format!("{}:", (b[0] as char).to_ascii_uppercase());
    let mut parts: Vec<&str> = Vec::new();
    for part in s[2..].split('\\') {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            x => {
                // NTFS alternate data streams ("file.txt:secret") and trailing dots / spaces (Windows drops them) are refused.
                if x.contains(':') || x.ends_with('.') || x.ends_with(' ') {
                    return None;
                }
                if x.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
                    return None;
                }
                parts.push(x);
            }
        }
    }
    if parts.is_empty() {
        return Some(format!("{drive}\\"));
    }
    Some(format!("{}\\{}", drive, parts.join("\\")))
}

/// A path the model gave, resolved: absolute as is; "~\x" / "%USERPROFILE%\x" / "$env:USERPROFILE\x"
/// under `home`; anything else relative to `base` (the JOYA AI documents folder).
pub fn resolve(p: &str, home: &str, base: &str) -> Option<String> {
    let raw = p.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let expanded = if let Some(rest) = raw.strip_prefix('~').filter(|r| r.is_empty() || r.starts_with(['\\', '/'])) {
        format!("{home}{rest}")
    } else if lower.starts_with("%userprofile%") {
        format!("{home}{}", &raw["%userprofile%".len()..])
    } else if lower.starts_with("$env:userprofile") {
        format!("{home}{}", &raw["$env:userprofile".len()..])
    } else if lower.starts_with("$home") && (raw.len() == 5 || raw[5..].starts_with(['\\', '/'])) {
        format!("{home}{}", &raw[5..])
    } else {
        raw.to_string()
    };
    if expanded.contains('%') || (expanded.contains('$') && expanded.to_ascii_lowercase().contains("env:")) {
        return None; // another variable: its value is not known here
    }
    absolute(&expanded).or_else(|| if looks_relative(&expanded) { absolute(&format!("{base}\\{expanded}")) } else { None })
}

fn looks_relative(p: &str) -> bool {
    let b = p.as_bytes();
    !(p.starts_with(['\\', '/']) || b.len() >= 2 && b[1] == b':')
}

/// Is `p` (normalised) inside one of `roots`? Some(that root) when it is.
pub fn root_of<'a>(p: &str, roots: &'a [Root]) -> Option<&'a Root> {
    let low = p.to_lowercase();
    roots.iter().filter(|r| {
        let rl = r.path.to_lowercase();
        low == rl || low.starts_with(&(rl.trim_end_matches('\\').to_string() + "\\"))
    }).max_by_key(|r| r.path.len())
}

/// The plain refusal for a path outside the allowed folders.
pub fn outside_msg(p: &str, roots: &[Root]) -> String {
    let names: Vec<&str> = {
        let mut v: Vec<&str> = roots.iter().map(|r| r.label.as_str()).collect();
        v.dedup();
        v
    };
    format!(
        "{} is outside the folders JOYA AI may use on this computer ({}). The user can add a folder on the Computers page in Joya.",
        p,
        if names.is_empty() { "none are set".to_string() } else { names.join(", ") }
    )
}

/// Resolve and check in one go: the normalised path, or the message to give back.
pub fn allowed(p: &str, home: &str, base: &str, roots: &[Root]) -> Result<String, String> {
    let Some(n) = resolve(p, home, base) else {
        return Err(format!("\"{}\" is not a path on this computer's drives (network and device paths are not allowed).", p.chars().take(200).collect::<String>()));
    };
    if root_of(&n, roots).is_none() {
        return Err(outside_msg(&n, roots));
    }
    // Hidden or app-data folders inside a root are not the user's documents.
    let low = n.to_lowercase();
    if low.split('\\').any(|seg| seg.starts_with('.') && seg.len() > 1 && seg != "..") || low.contains("\\appdata\\") {
        return Err(format!("{n} is in a hidden or app-data folder, which JOYA AI does not use."));
    }
    Ok(n)
}

/// A folder the user adds on the Computers page: an absolute local folder, not a whole drive, not
/// the system's or the programs' folders, not app data. Ok(normalised) or Err(why).
pub fn folder_ok(p: &str) -> Result<String, String> {
    let Some(n) = absolute(p) else { return Err("Give a full folder path on this computer, like D:\\Work (no network paths).".into()) };
    if n.len() <= 3 {
        return Err("A whole drive is too wide: pick a folder on it.".into());
    }
    let low = n.to_lowercase();
    let first = low[3..].split('\\').next().unwrap_or("");
    const SYSTEM: &[&str] = &["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "boot", "perflogs"];
    if SYSTEM.contains(&first) {
        return Err(format!("{n} is a Windows or programs folder: JOYA AI never works there."));
    }
    if low.contains("\\appdata") || low.split('\\').any(|s| s.starts_with('.')) {
        return Err(format!("{n} is a hidden or app-data folder: pick one of your own folders."));
    }
    let segs: Vec<&str> = low[3..].split('\\').collect();
    if segs.len() == 2 && segs[0] == "users" || segs.len() == 1 && segs[0] == "users" {
        return Err("A whole user profile is too wide: pick a folder inside it.".into());
    }
    Ok(n)
}

/// Kinds the Office tools take, by extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Office {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
}

impl Office {
    pub fn ext(self) -> &'static str {
        match self {
            Office::Docx => "docx",
            Office::Xlsx => "xlsx",
            Office::Pptx => "pptx",
            Office::Pdf => "pdf",
        }
    }
    pub fn app(self) -> &'static str {
        match self {
            Office::Docx => "Word",
            Office::Xlsx => "Excel",
            Office::Pptx => "PowerPoint",
            Office::Pdf => "PDF",
        }
    }
}

/// Macro-enabled Office files: never opened in Office, never edited (they may be read as text).
pub const MACRO_EXTS: &[&str] = &["docm", "dotm", "xlsm", "xltm", "xlsb", "xlam", "pptm", "potm", "ppsm", "ppam", "sldm"];

pub fn ext_of(p: &str) -> String {
    let file = p.rsplit(['\\', '/']).next().unwrap_or(p);
    file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// The kind of an existing file the tools can work on. Err names why not (macros, old formats).
pub fn office_kind(p: &str) -> Result<Office, String> {
    let e = ext_of(p);
    match e.as_str() {
        "docx" => Ok(Office::Docx),
        "xlsx" => Ok(Office::Xlsx),
        "pptx" => Ok(Office::Pptx),
        "pdf" => Ok(Office::Pdf),
        x if MACRO_EXTS.contains(&x) => Err(format!("{p} is a macro-enabled file (.{x}): JOYA AI does not open or edit files with macros.")),
        "doc" | "xls" | "ppt" | "rtf" | "odt" | "ods" | "odp" => Err(format!("{p} is an older or other format (.{e}): save it as .docx, .xlsx or .pptx first (the user can do that in Office).")),
        _ => Err(format!("{p} is not a Word, Excel, PowerPoint or PDF file.")),
    }
}

/// The default name for an edited copy next to the original: "<stem> (edited).<ext>".
pub fn edited_copy(src: &str, ext: &str) -> String {
    let (dir, file) = src.rsplit_once('\\').unwrap_or(("", src));
    let stem = file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file);
    let stem = stem.strip_suffix(" (edited)").unwrap_or(stem);
    if dir.is_empty() {
        format!("{stem} (edited).{ext}")
    } else {
        format!("{dir}\\{stem} (edited).{ext}")
    }
}

/// `p`, or `p` with " (2)", " (3)" ... before the extension: the first that does not exist.
pub fn unique(p: &str, exists: &dyn Fn(&str) -> bool) -> String {
    if !exists(p) {
        return p.to_string();
    }
    let (dir, file) = p.rsplit_once('\\').unwrap_or(("", p));
    let (stem, ext) = file.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((file.to_string(), String::new()));
    for n in 2..10_000 {
        let c = if dir.is_empty() { format!("{stem} ({n}){ext}") } else { format!("{dir}\\{stem} ({n}){ext}") };
        if !exists(&c) {
            return c;
        }
    }
    format!("{dir}\\{stem} ({}){ext}", std::process::id())
}

/// Same path, ignoring case (Windows).
pub fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b) || a.to_lowercase() == b.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rs() -> Vec<Root> {
        roots("C:\\Users\\a\\Documents", "C:\\Users\\a\\Desktop", "C:/Users/a/Downloads", &["C:\\Users\\a\\OneDrive - Giza", "", "C:\\Users\\a\\OneDrive - Giza"], &["D:\\Work".into(), "C:\\Windows\\System32".into(), "E:\\".into()])
    }

    #[test]
    fn the_roots() {
        let r = rs();
        let p: Vec<&str> = r.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(p, vec!["C:\\Users\\a\\Documents", "C:\\Users\\a\\Desktop", "C:\\Users\\a\\Downloads", "C:\\Users\\a\\OneDrive - Giza", "D:\\Work"], "deduplicated; system folders and drives dropped");
        assert_eq!(r[3].label, "OneDrive");
    }

    #[test]
    fn absolute_paths() {
        assert_eq!(absolute("c:/Users/a/../a/x.docx").as_deref(), Some("C:\\Users\\a\\x.docx"));
        assert_eq!(absolute("C:\\a\\..\\..\\..\\b").as_deref(), Some("C:\\b"), ".. never climbs above the drive");
        assert_eq!(absolute("\\\\server\\share\\x"), None);
        assert_eq!(absolute("\\\\?\\C:\\x"), None);
        assert_eq!(absolute("\\\\.\\PhysicalDrive0"), None);
        assert_eq!(absolute("C:x.docx"), None);
        assert_eq!(absolute("x.docx"), None);
        assert_eq!(absolute("C:\\a\\x.txt:hidden"), None, "alternate data stream");
        assert_eq!(absolute("C:\\a\\x.docx."), None, "trailing dot");
        assert_eq!(absolute("C:\\a\\*.docx"), None);
    }

    #[test]
    fn resolving_and_checking() {
        let r = rs();
        let (home, base) = ("C:\\Users\\a", "C:\\Users\\a\\Documents\\JOYA AI");
        assert_eq!(allowed("~\\Desktop\\x.docx", home, base, &r).unwrap(), "C:\\Users\\a\\Desktop\\x.docx");
        assert_eq!(allowed("%USERPROFILE%\\Documents\\q.xlsx", home, base, &r).unwrap(), "C:\\Users\\a\\Documents\\q.xlsx");
        assert_eq!(allowed("$env:USERPROFILE\\Downloads\\a.pdf", home, base, &r).unwrap(), "C:\\Users\\a\\Downloads\\a.pdf");
        assert_eq!(allowed("Budget.xlsx", home, base, &r).unwrap(), "C:\\Users\\a\\Documents\\JOYA AI\\Budget.xlsx");
        assert_eq!(allowed("d:\\work\\sub\\a.pptx", home, base, &r).unwrap(), "D:\\work\\sub\\a.pptx");
        assert_eq!(allowed("C:\\Users\\a\\OneDrive - Giza\\x.docx", home, base, &r).unwrap(), "C:\\Users\\a\\OneDrive - Giza\\x.docx");
        for bad in [
            "C:\\Users\\a\\AppData\\Roaming\\x.docx",
            "C:\\Users\\a\\x.docx",
            "C:\\Windows\\x.docx",
            "C:\\Users\\a\\Documents\\..\\AppData\\x.docx",
            "..\\..\\AppData\\x.docx",
            "\\\\server\\share\\x.docx",
            "%APPDATA%\\x.docx",
            "C:\\Users\\a\\Documents\\.secret\\x.docx",
            "C:\\Users\\a\\Documentsx\\y.docx",
            "",
        ] {
            assert!(allowed(bad, home, base, &r).is_err(), "{bad} must be refused");
        }
        assert!(allowed("C:\\Users\\a\\x.docx", home, base, &r).unwrap_err().contains("Computers page"));
    }

    #[test]
    fn user_folders() {
        assert_eq!(folder_ok("d:/work/").unwrap(), "D:\\work");
        assert!(folder_ok("D:\\").is_err());
        assert!(folder_ok("C:\\Windows").is_err());
        assert!(folder_ok("c:\\program files\\x").is_err());
        assert!(folder_ok("C:\\ProgramData\\x").is_err());
        assert!(folder_ok("C:\\Users\\a\\AppData\\Local\\x").is_err());
        assert!(folder_ok("C:\\Users\\a").is_err(), "a whole profile");
        assert!(folder_ok("C:\\Users").is_err());
        assert!(folder_ok("\\\\nas\\share").is_err());
        assert_eq!(folder_ok("C:\\Users\\a\\Projects").unwrap(), "C:\\Users\\a\\Projects");
    }

    #[test]
    fn kinds_and_names() {
        assert_eq!(office_kind("C:\\a\\B.DOCX").unwrap(), Office::Docx);
        assert_eq!(office_kind("x.pdf").unwrap(), Office::Pdf);
        assert!(office_kind("x.xlsm").unwrap_err().contains("macro"));
        assert!(office_kind("x.docm").unwrap_err().contains("macro"));
        assert!(office_kind("x.doc").unwrap_err().contains("older"));
        assert!(office_kind("x.exe").is_err());
        assert_eq!(edited_copy("C:\\a\\Report.docx", "docx"), "C:\\a\\Report (edited).docx");
        assert_eq!(edited_copy("C:\\a\\Report (edited).docx", "docx"), "C:\\a\\Report (edited).docx");
        assert_eq!(edited_copy("C:\\a\\Deck.pptx", "pdf"), "C:\\a\\Deck (edited).pdf");
        let taken = ["C:\\a\\R (edited).docx", "C:\\a\\R (edited) (2).docx"];
        assert_eq!(unique("C:\\a\\R (edited).docx", &|p: &str| taken.contains(&p)), "C:\\a\\R (edited) (3).docx");
        assert_eq!(unique("C:\\a\\new.docx", &|p: &str| taken.contains(&p)), "C:\\a\\new.docx");
        assert!(same("C:\\A\\b.docx", "c:\\a\\B.docx"));
    }
}
