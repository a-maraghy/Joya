//! Reading and editing existing Word, Excel and PowerPoint files as files (pure; unit-tested in
//! core-tests). This is the engine when Office is not installed (and always for reading): the
//! package is unzipped, the few XML parts that change are edited in place -- everything else, byte
//! for byte, as it was -- and zipped again. Nothing in the file is ever run: macro-enabled packages
//! (a vbaProject part) are refused outright.
//!
//! The edits (also the shape the Office (COM) engine takes, see office_com.rs):
//!   docx  replace {find, with, all?, match_case?} · set_paragraph {index, text}
//!         · insert_paragraph {text, after?, style?} · delete_paragraph {index}
//!   xlsx  set_cells {sheet?, cell, values: [[v]]}  (v = text | number | bool | null | "=FORMULA")
//!         · add_sheet {name, rows?}
//!   pptx  replace {find, with, all?, match_case?, slide?} · set_slide {slide, title?, bullets?, notes?}
//!         · add_slide {title?, bullets?, after?} · delete_slide {slide}
//! Paragraph and slide numbers are 1-based, as office_read lists them.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};

use super::paths::Office;

const MAX_ENTRIES: usize = 20_000;
const MAX_UNZIPPED: u64 = 400 * 1024 * 1024;
pub const MAX_OPS: usize = 200;

/* =========================================================================== the package */

/// The parts of an OOXML zip, in their order.
pub struct Package {
    pub parts: Vec<(String, Vec<u8>)>,
}

impl Package {
    pub fn open(bytes: &[u8]) -> Result<Package, String> {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "This is not a valid Office file (it is not a zip package).".to_string())?;
        if z.len() > MAX_ENTRIES {
            return Err("This file has too many parts to open safely.".into());
        }
        let mut parts = Vec::with_capacity(z.len());
        let mut total = 0u64;
        for i in 0..z.len() {
            let mut f = z.by_index(i).map_err(|e| format!("Cannot read the file: {e}"))?;
            if f.is_dir() {
                continue;
            }
            total += f.size();
            if total > MAX_UNZIPPED {
                return Err("This file unpacks to more than 400 MB; it is not opened.".into());
            }
            let name = f.name().to_string();
            let mut buf = Vec::with_capacity(f.size().min(64 * 1024 * 1024) as usize);
            (&mut f).take(MAX_UNZIPPED).read_to_end(&mut buf).map_err(|e| format!("Cannot read {name}: {e}"))?;
            parts.push((name, buf));
        }
        Ok(Package { parts })
    }

    pub fn has_macros(&self) -> bool {
        self.parts.iter().any(|(n, _)| n.to_ascii_lowercase().ends_with("vbaproject.bin") || n.to_ascii_lowercase().ends_with("vbadata.xml"))
            || self.text("[Content_Types].xml").map(|t| t.to_ascii_lowercase().contains("macroenabled")).unwrap_or(false)
    }

    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.parts.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, b)| b.as_slice())
    }

    pub fn text(&self, name: &str) -> Option<String> {
        self.get(name).map(|b| String::from_utf8_lossy(b).trim_start_matches('\u{feff}').to_string())
    }

    pub fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub fn put(&mut self, name: &str, body: String) {
        if let Some(p) = self.parts.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
            p.1 = body.into_bytes();
        } else {
            self.parts.push((name.to_string(), body.into_bytes()));
        }
    }

    pub fn remove(&mut self, name: &str) {
        self.parts.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
    }

    pub fn names(&self) -> Vec<String> {
        self.parts.iter().map(|(n, _)| n.clone()).collect()
    }

    pub fn save(&self) -> Result<Vec<u8>, String> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            // [Content_Types].xml first, as Office writes it.
            let mut order: Vec<&(String, Vec<u8>)> = self.parts.iter().collect();
            order.sort_by_key(|(n, _)| if n == "[Content_Types].xml" { 0 } else { 1 });
            for (name, body) in order {
                z.start_file(name.as_str(), opts).map_err(|e| e.to_string())?;
                z.write_all(body).map_err(|e| e.to_string())?;
            }
            z.finish().map_err(|e| e.to_string())?;
        }
        Ok(buf.into_inner())
    }

    /// The relationships of a part: Id -> (Type, Target resolved to a part name).
    pub fn rels_of(&self, part: &str) -> BTreeMap<String, (String, String)> {
        let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
        let rels_name = if dir.is_empty() { format!("_rels/{file}.rels") } else { format!("{dir}/_rels/{file}.rels") };
        let mut out = BTreeMap::new();
        let Some(x) = self.text(&rels_name) else { return out };
        for t in tokens(&x) {
            if let Tok::Open { name, raw, .. } = t {
                if local(name) == "Relationship" {
                    if let (Some(id), Some(ty), Some(target)) = (attr(raw, "Id"), attr(raw, "Type"), attr(raw, "Target")) {
                        if attr(raw, "TargetMode").as_deref() == Some("External") {
                            continue;
                        }
                        out.insert(id, (ty, join_part(dir, &target)));
                    }
                }
            }
        }
        out
    }
}

pub fn rels_name(part: &str) -> String {
    let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
    if dir.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{dir}/_rels/{file}.rels")
    }
}

/// A relationship target relative to `dir` (or absolute "/xl/...") -> a part name.
pub fn join_part(dir: &str, target: &str) -> String {
    let t = target.replace('\\', "/");
    let mut parts: Vec<&str> = if t.starts_with('/') { Vec::new() } else { dir.split('/').filter(|s| !s.is_empty()).collect() };
    for seg in t.trim_start_matches('/').split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/* =========================================================================== a small XML scanner */

/// One token of an XML text with its byte range. Office's parts are well-formed XML; this keeps
/// every byte's position so edits can be spliced in without touching the rest.
#[derive(Clone, Debug, PartialEq)]
pub enum Tok<'a> {
    Open { name: &'a str, raw: &'a str, start: usize, end: usize, empty: bool },
    Close { name: &'a str, start: usize, end: usize },
    Text { start: usize, end: usize },
    Other { start: usize, end: usize },
}

pub fn tokens(x: &str) -> Vec<Tok<'_>> {
    let b = x.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'<' {
            let st = i;
            while i < b.len() && b[i] != b'<' {
                i += 1;
            }
            out.push(Tok::Text { start: st, end: i });
            continue;
        }
        let st = i;
        let rest = &x[i..];
        let end_of = |pat: &str| rest.find(pat).map(|k| i + k + pat.len()).unwrap_or(b.len());
        if rest.starts_with("<?") {
            i = end_of("?>");
            out.push(Tok::Other { start: st, end: i });
        } else if rest.starts_with("<!--") {
            i = end_of("-->");
            out.push(Tok::Other { start: st, end: i });
        } else if rest.starts_with("<![CDATA[") {
            i = end_of("]]>");
            out.push(Tok::Other { start: st, end: i });
        } else if rest.starts_with("<!") {
            i = end_of(">");
            out.push(Tok::Other { start: st, end: i });
        } else if rest.starts_with("</") {
            i = end_of(">");
            let name = x[st + 2..i.saturating_sub(1).max(st + 2)].trim();
            out.push(Tok::Close { name, start: st, end: i });
        } else {
            // An opening tag: to the '>' outside quotes.
            let mut j = i + 1;
            let mut q: Option<u8> = None;
            while j < b.len() {
                match (q, b[j]) {
                    (None, b'"') | (None, b'\'') => q = Some(b[j]),
                    (Some(c), d) if c == d => q = None,
                    (None, b'>') => break,
                    _ => {}
                }
                j += 1;
            }
            let end = (j + 1).min(b.len());
            let raw = &x[st..end];
            let empty = raw.ends_with("/>");
            let name_end = raw[1..].find(|c: char| c.is_whitespace() || c == '/' || c == '>').map(|k| k + 1).unwrap_or(raw.len());
            out.push(Tok::Open { name: &raw[1..name_end], raw, start: st, end, empty });
            i = end;
        }
    }
    out
}

/// "w:p" -> "p".
pub fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// Where an attribute sits in a raw opening tag: (start of the leading space, end after the closing
/// quote, the value's start, the value's end).
fn attr_span(raw: &str, name: &str) -> Option<(usize, usize, usize, usize)> {
    let b = raw.as_bytes();
    let mut i = 0;
    while let Some(k) = raw[i..].find(name) {
        let at = i + k;
        let before_ok = at > 0 && (b[at - 1] as char).is_whitespace();
        let mut j = at + name.len();
        while j < b.len() && (b[j] as char).is_whitespace() {
            j += 1;
        }
        if before_ok && j < b.len() && b[j] == b'=' {
            j += 1;
            while j < b.len() && (b[j] as char).is_whitespace() {
                j += 1;
            }
            if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                let q = b[j] as char;
                let st = j + 1;
                let en = raw[st..].find(q).map(|e| st + e)?;
                let mut lead = at;
                while lead > 0 && (b[lead - 1] as char).is_whitespace() {
                    lead -= 1;
                }
                return Some((lead, en + 1, st, en));
            }
        }
        i = at + name.len();
    }
    None
}

/// An attribute of a raw opening tag (`name="v"` or `name='v'`), unescaped.
pub fn attr(raw: &str, name: &str) -> Option<String> {
    attr_span(raw, name).map(|(_, _, s, e)| unescape(&raw[s..e]))
}

/// The opening tag with one attribute set (its value replaced, or added at the end).
pub fn set_attr(raw: &str, name: &str, value: &str) -> String {
    if let Some((_, _, s, e)) = attr_span(raw, name) {
        let mut out = raw.to_string();
        out.replace_range(s..e, &esc(value));
        return out;
    }
    let empty = raw.ends_with("/>");
    let body = raw.trim_end_matches('>').trim_end_matches('/').trim_end();
    format!("{body} {name}=\"{}\"{}", esc(value), if empty { "/>" } else { ">" })
}

pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(k) = rest.find('&') {
        out.push_str(&rest[..k]);
        let r = &rest[k..];
        let Some(semi) = r.find(';').filter(|&e| e <= 12) else {
            out.push('&');
            rest = &r[1..];
            continue;
        };
        let ent = &r[1..semi];
        let c = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &r[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &r[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// XML text / attribute escaping; characters XML 1.0 cannot carry are dropped.
pub fn esc(s: &str) -> String {
    super::docs::xml(s)
}

/// Splice edits (start, end, replacement) into `x`; ranges must not overlap.
pub fn splice(x: &str, mut edits: Vec<(usize, usize, String)>) -> String {
    edits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out = x.to_string();
    for (s, e, r) in edits {
        out.replace_range(s..e, &r);
    }
    out
}

/// The index of the token closing the element opened at token `i` (itself when empty).
fn close_of(t: &[Tok], i: usize) -> usize {
    let Tok::Open { name, empty, .. } = t[i] else { return i };
    if empty {
        return i;
    }
    let mut depth = 0usize;
    for (k, tok) in t.iter().enumerate().skip(i) {
        match tok {
            Tok::Open { name: n, empty: false, .. } if *n == name => depth += 1,
            Tok::Close { name: n, .. } if *n == name => {
                depth -= 1;
                if depth == 0 {
                    return k;
                }
            }
            _ => {}
        }
    }
    t.len() - 1
}

fn span(t: &[Tok], i: usize) -> (usize, usize) {
    let s = match t[i] {
        Tok::Open { start, .. } | Tok::Close { start, .. } | Tok::Text { start, .. } | Tok::Other { start, .. } => start,
    };
    let e = match t[close_of(t, i)] {
        Tok::Open { end, .. } | Tok::Close { end, .. } | Tok::Text { end, .. } | Tok::Other { end, .. } => end,
    };
    (s, e)
}

fn open_end(t: &[Tok], i: usize) -> usize {
    match t[i] {
        Tok::Open { end, .. } => end,
        _ => 0,
    }
}

fn close_start(t: &[Tok], i: usize) -> usize {
    match t[close_of(t, i)] {
        Tok::Close { start, .. } => start,
        Tok::Open { start, .. } => start,
        _ => 0,
    }
}

/* =========================================================================== edits, parsed */

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Replace { find: String, with: String, all: bool, match_case: bool, slide: Option<usize> },
    SetParagraph { index: usize, text: String },
    InsertParagraph { text: String, after: Option<usize>, style: Option<String> },
    DeleteParagraph { index: usize },
    SetCells { sheet: Option<String>, cell: String, values: Vec<Vec<Value>> },
    AddSheet { name: String, rows: Vec<Vec<Value>> },
    SetSlide { slide: usize, title: Option<String>, bullets: Option<Vec<String>>, notes: Option<String> },
    AddSlide { title: String, bullets: Vec<String>, after: Option<usize> },
    DeleteSlide { slide: usize },
}

fn s_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| match x {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}
fn n_of(v: &Value, k: &str) -> Option<usize> {
    v.get(k).and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))).map(|n| n as usize)
}
fn b_of(v: &Value, k: &str, d: bool) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(d)
}
fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    match v? {
        Value::Array(a) => Some(a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect()),
        Value::String(s) => Some(s.lines().map(str::to_string).collect()),
        _ => None,
    }
}
fn rows_of(v: Option<&Value>) -> Result<Vec<Vec<Value>>, String> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let Some(a) = v.as_array() else { return Err("values / rows must be a list of rows, each a list of cells.".into()) };
    let mut out = Vec::new();
    for r in a {
        match r {
            Value::Array(c) => out.push(c.clone()),
            other => out.push(vec![other.clone()]), // a single column given as a flat list
        }
    }
    if out.iter().map(Vec::len).sum::<usize>() > 100_000 {
        return Err("At most 100,000 cells per edit.".into());
    }
    Ok(out)
}

/// The edits, checked for this kind of file.
pub fn parse_ops(kind: Office, v: &Value) -> Result<Vec<Op>, String> {
    let Some(list) = v.as_array() else { return Err("edits must be a list, e.g. [{\"replace\": {\"find\": \"2025\", \"with\": \"2026\"}}].".into()) };
    if list.is_empty() {
        return Err("No edits given.".into());
    }
    if list.len() > MAX_OPS {
        return Err(format!("At most {MAX_OPS} edits at once."));
    }
    let mut out = Vec::new();
    for (i, e) in list.iter().enumerate() {
        let Some(obj) = e.as_object().filter(|o| o.len() == 1) else { return Err(format!("Edit {}: one key per edit, like {{\"replace\": {{...}}}}.", i + 1)) };
        let (k, a) = obj.iter().next().unwrap();
        let need = |ok: bool, what: &str| if ok { Ok(()) } else { Err(format!("Edit {} ({k}): {what}", i + 1)) };
        let op = match (kind, k.as_str()) {
            (Office::Docx | Office::Pptx, "replace") => {
                let find = s_of(a, "find").unwrap_or_default();
                need(!find.is_empty() && find.chars().count() <= 2000, "\"find\" must be some text (up to 2000 characters).")?;
                let with = s_of(a, "with").or_else(|| s_of(a, "replace")).unwrap_or_default();
                need(with.chars().count() <= 20_000, "\"with\" is too long.")?;
                Op::Replace { find, with, all: b_of(a, "all", true), match_case: b_of(a, "match_case", true), slide: n_of(a, "slide") }
            }
            (Office::Docx, "set_paragraph") => {
                let index = n_of(a, "index").unwrap_or(0);
                need(index >= 1, "\"index\" is the paragraph number from office_read (1 = the first).")?;
                Op::SetParagraph { index, text: s_of(a, "text").unwrap_or_default() }
            }
            (Office::Docx, "insert_paragraph") => {
                let text = s_of(a, "text").unwrap_or_default();
                need(text.chars().count() <= 20_000, "\"text\" is too long.")?;
                let style = s_of(a, "style").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                if let Some(s) = &style {
                    need(word_style(s).is_some(), "\"style\" is one of normal, title, h1, h2, h3, bullet, numbered.")?;
                }
                Op::InsertParagraph { text, after: n_of(a, "after"), style }
            }
            (Office::Docx, "delete_paragraph") => {
                let index = n_of(a, "index").unwrap_or(0);
                need(index >= 1, "\"index\" is the paragraph number from office_read.")?;
                Op::DeleteParagraph { index }
            }
            (Office::Xlsx, "set_cells") => {
                let cell = s_of(a, "cell").or_else(|| s_of(a, "range")).unwrap_or_default();
                let cell = cell.split(':').next().unwrap_or("").trim().to_uppercase();
                need(cell_ref(&cell).is_some(), "\"cell\" is the top-left cell, like \"B2\".")?;
                let values = rows_of(a.get("values"))?;
                need(!values.is_empty(), "\"values\" is a list of rows, e.g. [[\"Total\", \"=SUM(B2:B9)\"]].")?;
                Op::SetCells { sheet: s_of(a, "sheet"), cell, values }
            }
            (Office::Xlsx, "add_sheet") => {
                let name = s_of(a, "name").unwrap_or_default();
                need(sheet_name_ok(&name), "\"name\" is 1-31 characters without : \\ / ? * [ ].")?;
                Op::AddSheet { name, rows: rows_of(a.get("rows"))? }
            }
            (Office::Pptx, "set_slide") => {
                let slide = n_of(a, "slide").unwrap_or(0);
                need(slide >= 1, "\"slide\" is the slide number from office_read.")?;
                let (title, bullets, notes) = (s_of(a, "title"), strings(a.get("bullets")), s_of(a, "notes"));
                need(title.is_some() || bullets.is_some() || notes.is_some(), "give a title, bullets or notes.")?;
                Op::SetSlide { slide, title, bullets, notes }
            }
            (Office::Pptx, "add_slide") => Op::AddSlide { title: s_of(a, "title").unwrap_or_default(), bullets: strings(a.get("bullets")).unwrap_or_default(), after: n_of(a, "after") },
            (Office::Pptx, "delete_slide") => {
                let slide = n_of(a, "slide").unwrap_or(0);
                need(slide >= 1, "\"slide\" is the slide number from office_read.")?;
                Op::DeleteSlide { slide }
            }
            _ => return Err(format!("Edit {}: \"{k}\" is not an edit for a {} file ({}).", i + 1, kind.app(), ops_for(kind))),
        };
        out.push(op);
    }
    Ok(out)
}

pub fn ops_for(kind: Office) -> &'static str {
    match kind {
        Office::Docx => "replace, set_paragraph, insert_paragraph, delete_paragraph",
        Office::Xlsx => "set_cells, add_sheet",
        Office::Pptx => "replace, set_slide, add_slide, delete_slide",
        Office::Pdf => "none: PDFs are read and merged, not edited",
    }
}

/// The edits as plain JSON for the Office engine (every default filled in).
pub fn ops_json(ops: &[Op]) -> Value {
    Value::Array(
        ops.iter()
            .map(|o| match o {
                Op::Replace { find, with, all, match_case, slide } => json!({"op": "replace", "find": find, "with": with, "all": all, "match_case": match_case, "slide": slide}),
                Op::SetParagraph { index, text } => json!({"op": "set_paragraph", "index": index, "text": text}),
                Op::InsertParagraph { text, after, style } => {
                    let st = style.as_deref().and_then(word_style);
                    json!({"op": "insert_paragraph", "text": text, "after": after, "style": st.map(|s| s.0), "style_builtin": st.map(|s| s.1)})
                }
                Op::DeleteParagraph { index } => json!({"op": "delete_paragraph", "index": index}),
                Op::SetCells { sheet, cell, values } => json!({"op": "set_cells", "sheet": sheet, "cell": cell, "values": values}),
                Op::AddSheet { name, rows } => json!({"op": "add_sheet", "name": name, "rows": rows}),
                Op::SetSlide { slide, title, bullets, notes } => json!({"op": "set_slide", "slide": slide, "title": title, "bullets": bullets, "notes": notes}),
                Op::AddSlide { title, bullets, after } => json!({"op": "add_slide", "title": title, "bullets": bullets, "after": after}),
                Op::DeleteSlide { slide } => json!({"op": "delete_slide", "slide": slide}),
            })
            .collect(),
    )
}

/// A friendly style name -> (the Word style name, Word's built-in style number for COM).
pub fn word_style(s: &str) -> Option<(&'static str, i32)> {
    match s.trim().to_ascii_lowercase().replace([' ', '_', '-'], "").as_str() {
        "normal" | "p" | "body" => Some(("normal", -1)),
        "title" => Some(("title", -63)),
        "h1" | "heading1" => Some(("heading 1", -2)),
        "h2" | "heading2" => Some(("heading 2", -3)),
        "h3" | "heading3" => Some(("heading 3", -4)),
        "bullet" | "listbullet" | "bullets" => Some(("list bullet", -49)),
        "numbered" | "listnumber" | "number" => Some(("list number", -50)),
        _ => None,
    }
}

pub fn sheet_name_ok(n: &str) -> bool {
    let c = n.chars().count();
    (1..=31).contains(&c) && !n.chars().any(|c| matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']') || c.is_control()) && !n.starts_with('\'') && !n.ends_with('\'')
}

/// "B12" -> (column 2, row 12).
pub fn cell_ref(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().trim_start_matches('$');
    let letters: String = s.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let rest = s[letters.len()..].trim_start_matches('$');
    if letters.is_empty() || letters.len() > 3 || rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut col = 0u32;
    for c in letters.chars() {
        col = col * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    let row: u32 = rest.parse().ok()?;
    if col == 0 || col > 16_384 || row == 0 || row > 1_048_576 {
        return None;
    }
    Some((col, row))
}

pub fn col_name(mut col: u32) -> String {
    let mut s = Vec::new();
    while col > 0 {
        let r = (col - 1) % 26;
        s.push((b'A' + r as u8) as char);
        col = (col - 1) / 26;
    }
    s.iter().rev().collect()
}

/* =========================================================================== text matching */

/// Replace `find` in a run of text pieces (the text nodes of one paragraph), keeping the pieces:
/// a match's new text goes into the piece where the match starts; its other characters are taken
/// out of the pieces they were in. Returns the new pieces and how many matches were replaced.
pub fn replace_in_pieces(pieces: &[String], find: &str, with: &str, all: bool, match_case: bool, budget: &mut usize) -> (Vec<String>, usize) {
    let joined: Vec<char> = pieces.iter().flat_map(|p| p.chars()).collect();
    let f: Vec<char> = find.chars().collect();
    let mut owner = Vec::with_capacity(joined.len());
    for (k, p) in pieces.iter().enumerate() {
        owner.extend(std::iter::repeat(k).take(p.chars().count()));
    }
    let fold = |c: char| if match_case { c } else { c.to_lowercase().next().unwrap_or(c) };
    let mut out: Vec<String> = vec![String::new(); pieces.len()];
    let mut i = 0;
    let mut n = 0;
    while i < joined.len() {
        let hit = *budget > 0 && !f.is_empty() && i + f.len() <= joined.len() && (0..f.len()).all(|k| fold(joined[i + k]) == fold(f[k]));
        if hit {
            out[owner[i]].push_str(with);
            i += f.len();
            n += 1;
            if !all {
                *budget = 0;
            }
            continue;
        }
        out[owner[i]].push(joined[i]);
        i += 1;
    }
    (out, n)
}

/* =========================================================================== Word */

struct WText {
    open: usize, // token index of <w:t>
    text: String,
}

struct WPara {
    tok: usize, // token index of <w:p>
    texts: Vec<WText>,
    style: Option<String>,
    in_table: bool,
    cell: Option<usize>, // token index of its <w:tc>
}

fn word_paras(t: &[Tok], x: &str) -> Vec<WPara> {
    let mut out: Vec<WPara> = Vec::new();
    let mut stack: Vec<(&str, usize)> = Vec::new();
    let mut cur: Vec<usize> = Vec::new(); // indices into out, open paragraphs that count
    let mut skip = 0usize; // inside w:txbxContent / mc:Fallback
    let mut i = 0;
    while i < t.len() {
        match &t[i] {
            Tok::Open { name, raw, empty, .. } => {
                let n = *name;
                if n == "w:txbxContent" || n == "mc:Fallback" {
                    if !*empty {
                        skip += 1;
                        stack.push((n, i));
                    }
                    i += 1;
                    continue;
                }
                if skip == 0 {
                    if n == "w:p" {
                        let in_table = stack.iter().any(|(s, _)| *s == "w:tbl");
                        let cell = stack.iter().rev().find(|(s, _)| *s == "w:tc").map(|(_, k)| *k);
                        out.push(WPara { tok: i, texts: Vec::new(), style: None, in_table, cell });
                        if !*empty {
                            cur.push(out.len() - 1);
                        }
                    } else if n == "w:pStyle" {
                        if let (Some(&p), Some(v)) = (cur.last(), attr(raw, "w:val")) {
                            if out[p].style.is_none() {
                                out[p].style = Some(v);
                            }
                        }
                    } else if n == "w:t" && !*empty {
                        if let Some(&p) = cur.last() {
                            let (s, e) = (open_end(t, i), close_start(t, i));
                            out[p].texts.push(WText { open: i, text: unescape(&x[s..e]) });
                        }
                    } else if (n == "w:tab" || n == "w:br" || n == "w:cr") && *empty {
                        // Kept as is; shown as a space in the listing.
                    }
                }
                if !*empty {
                    stack.push((n, i));
                }
            }
            Tok::Close { name, .. } => {
                if let Some(pos) = stack.iter().rposition(|(s, _)| s == name) {
                    stack.truncate(pos);
                }
                if *name == "w:txbxContent" || *name == "mc:Fallback" {
                    skip = skip.saturating_sub(1);
                } else if *name == "w:p" && skip == 0 {
                    cur.pop();
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn para_text(p: &WPara) -> String {
    p.texts.iter().map(|t| t.text.as_str()).collect()
}

/// The body-level end: before the last <w:sectPr> child of <w:body>, else before </w:body>.
fn word_body_end(t: &[Tok]) -> Option<usize> {
    let body = t.iter().position(|k| matches!(k, Tok::Open { name: "w:body", empty: false, .. }))?;
    let close = close_of(t, body);
    // Direct children of body: walk them.
    let mut i = body + 1;
    let mut last_sect = None;
    while i < close {
        if let Tok::Open { name, start, .. } = t[i] {
            if name == "w:sectPr" {
                last_sect = Some(start);
            }
            i = close_of(t, i) + 1;
            continue;
        }
        i += 1;
    }
    Some(last_sect.unwrap_or(match t[close] {
        Tok::Close { start, .. } => start,
        _ => return None,
    }))
}

/// Paragraph XML for new text: \n -> line breaks, \t -> tabs; Arabic set right-to-left.
pub fn w_new_para(text: &str, style_id: Option<&str>, ppr_raw: Option<&str>, rpr_raw: Option<&str>) -> String {
    let rtl = super::docs::mostly_arabic(text);
    let ppr = match (ppr_raw, style_id) {
        (Some(raw), _) => raw.to_string(),
        (None, Some(s)) => format!("<w:pPr><w:pStyle w:val=\"{}\"/>{}</w:pPr>", esc(s), if rtl { "<w:bidi/>" } else { "" }),
        (None, None) if rtl => "<w:pPr><w:bidi/></w:pPr>".to_string(),
        _ => String::new(),
    };
    format!("<w:p>{ppr}{}</w:p>", w_run(text, rpr_raw, rtl && rpr_raw.is_none()))
}

fn w_run(text: &str, rpr_raw: Option<&str>, rtl: bool) -> String {
    let rpr = rpr_raw.map(str::to_string).unwrap_or_else(|| if rtl { "<w:rPr><w:rtl/></w:rPr>".into() } else { String::new() });
    let mut inner = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            inner.push_str("<w:br/>");
        }
        for (j, piece) in line.trim_end_matches('\r').split('\t').enumerate() {
            if j > 0 {
                inner.push_str("<w:tab/>");
            }
            if !piece.is_empty() {
                inner.push_str(&format!("<w:t xml:space=\"preserve\">{}</w:t>", esc(piece)));
            }
        }
    }
    format!("<w:r>{rpr}{inner}</w:r>")
}

/// A w:t's new content: text with \n as a break and \t as a tab inside the same run.
fn w_t_content(open_raw: &str, text: &str) -> String {
    let _ = open_raw;
    let mut s = String::from("<w:t xml:space=\"preserve\">");
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            s.push_str("</w:t><w:br/><w:t xml:space=\"preserve\">");
        }
        for (j, piece) in line.trim_end_matches('\r').split('\t').enumerate() {
            if j > 0 {
                s.push_str("</w:t><w:tab/><w:t xml:space=\"preserve\">");
            }
            s.push_str(&esc(piece));
        }
    }
    s.push_str("</w:t>");
    s
}

/// The style id for a friendly style name, from styles.xml (its w:name), else the English id.
fn word_style_id(styles: Option<&str>, friendly: &str) -> Option<String> {
    let (name, _) = word_style(friendly)?;
    if name == "normal" {
        return None;
    }
    if let Some(sx) = styles {
        let t = tokens(sx);
        let mut cur_id: Option<String> = None;
        for k in &t {
            if let Tok::Open { name: n, raw, .. } = k {
                if *n == "w:style" {
                    cur_id = attr(raw, "w:styleId");
                } else if *n == "w:name" {
                    if let (Some(id), Some(v)) = (&cur_id, attr(raw, "w:val")) {
                        if v.eq_ignore_ascii_case(name) {
                            return Some(id.clone());
                        }
                    }
                }
            }
        }
    }
    Some(name.split(' ').map(|w| { let mut c = w.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() }).collect())
}

pub fn docx_read(pkg: &Package, max_chars: usize) -> Result<String, String> {
    let x = pkg.text("word/document.xml").ok_or("This Word file has no document part.")?;
    let t = tokens(&x);
    let paras = word_paras(&t, &x);
    let mut out = format!("{} paragraphs (numbers for set_paragraph / insert_paragraph after / delete_paragraph):\n", paras.len());
    for (i, p) in paras.iter().enumerate() {
        let text = para_text(p);
        let mut line = format!("[{}]", i + 1);
        if let Some(s) = &p.style {
            line += &format!(" ({s})");
        }
        if p.in_table {
            line += " (table)";
        }
        line += " ";
        line += &text;
        line.push('\n');
        if out.len() + line.len() > max_chars {
            out += &format!("… (cut at {max_chars} characters; {} more paragraphs)\n", paras.len() - i);
            break;
        }
        out += &line;
    }
    Ok(out)
}

/// The paragraphs' texts (for the Office engine: it finds a paragraph by its text and position).
pub fn docx_paragraph_texts(pkg: &Package) -> Vec<String> {
    let Some(x) = pkg.text("word/document.xml") else { return Vec::new() };
    let t = tokens(&x);
    word_paras(&t, &x).iter().map(para_text).collect()
}

fn docx_edit(pkg: &mut Package, ops: &[Op]) -> Result<Vec<String>, String> {
    let styles = pkg.text("word/styles.xml");
    let mut notes = Vec::new();
    for op in ops {
        let x = pkg.text("word/document.xml").ok_or("This Word file has no document part.")?;
        let t = tokens(&x);
        let paras = word_paras(&t, &x);
        let get = |i: usize| -> Result<&WPara, String> { paras.get(i.wrapping_sub(1)).ok_or_else(|| format!("There is no paragraph {i} (the document has {}).", paras.len())) };
        let new_x = match op {
            Op::Replace { find, with, all, match_case, .. } => {
                let mut edits = Vec::new();
                let mut total = 0;
                let mut budget = usize::MAX;
                for p in &paras {
                    if p.texts.is_empty() {
                        continue;
                    }
                    let pieces: Vec<String> = p.texts.iter().map(|w| w.text.clone()).collect();
                    let (new, n) = replace_in_pieces(&pieces, find, with, *all, *match_case, &mut budget);
                    if n == 0 {
                        continue;
                    }
                    total += n;
                    for (w, nt) in p.texts.iter().zip(new) {
                        if nt != w.text {
                            let (s, e) = span(&t, w.open);
                            let raw = match t[w.open] {
                                Tok::Open { raw, .. } => raw,
                                _ => "",
                            };
                            edits.push((s, e, w_t_content(raw, &nt)));
                        }
                    }
                    if budget == 0 {
                        break;
                    }
                }
                notes.push(format!("replaced \"{}\" {} time(s)", clip(find, 60), total));
                if total == 0 {
                    continue;
                }
                splice(&x, edits)
            }
            Op::SetParagraph { index, text } => {
                let p = get(*index)?;
                let (s, e) = span(&t, p.tok);
                let (ppr, rpr) = para_props(&t, &x, p.tok);
                notes.push(format!("paragraph {index} set"));
                let open = match t[p.tok] {
                    Tok::Open { raw, empty: false, .. } => raw.to_string(),
                    _ => "<w:p>".into(),
                };
                let body = w_new_para(text, None, ppr.as_deref().or(Some("")), rpr.as_deref());
                splice(&x, vec![(s, e, format!("{open}{}", &body["<w:p>".len()..]))])
            }
            Op::InsertParagraph { text, after, style } => {
                let id = style.as_deref().and_then(|s| word_style_id(styles.as_deref(), s));
                let xml_p = w_new_para(text, id.as_deref(), None, None);
                let at = match after {
                    None => word_body_end(&t).ok_or("The document has no body.")?,
                    Some(0) => match paras.first() {
                        Some(p) => span(&t, p.tok).0,
                        None => word_body_end(&t).ok_or("The document has no body.")?,
                    },
                    Some(n) => span(&t, get(*n)?.tok).1,
                };
                notes.push(match after {
                    None => "paragraph added at the end".to_string(),
                    Some(0) => "paragraph added at the start".to_string(),
                    Some(n) => format!("paragraph added after paragraph {n}"),
                });
                splice(&x, vec![(at, at, xml_p)])
            }
            Op::DeleteParagraph { index } => {
                let p = get(*index)?;
                let (s, e) = span(&t, p.tok);
                let only_in_cell = p.cell.is_some() && paras.iter().filter(|q| q.cell == p.cell).count() == 1;
                notes.push(format!("paragraph {index} deleted{}", if only_in_cell { " (emptied: a table cell keeps one paragraph)" } else { "" }));
                splice(&x, vec![(s, e, if only_in_cell { "<w:p/>".into() } else { String::new() })])
            }
            _ => return Err("That edit is not for a Word file.".into()),
        };
        pkg.put("word/document.xml", new_x);
    }
    Ok(notes)
}

/// A paragraph's w:pPr (raw) and its first run's w:rPr (raw), to keep the look when its text is set.
fn para_props(t: &[Tok], x: &str, p: usize) -> (Option<String>, Option<String>) {
    let end = close_of(t, p);
    let mut ppr = None;
    let mut rpr = None;
    let mut i = p + 1;
    while i < end {
        if let Tok::Open { name, .. } = t[i] {
            if name == "w:pPr" && ppr.is_none() {
                let (s, e) = span(t, i);
                ppr = Some(x[s..e].to_string());
                i = close_of(t, i) + 1;
                continue;
            }
            if name == "w:rPr" && rpr.is_none() {
                let (s, e) = span(t, i);
                rpr = Some(x[s..e].to_string());
            }
            if name == "w:r" && rpr.is_some() {
                break;
            }
        }
        i += 1;
    }
    // A paragraph's own run properties inside pPr (w:pPr/w:rPr) are not the text's.
    (ppr, rpr.filter(|r| !r.is_empty()))
}

fn clip(s: &str, n: usize) -> String {
    let c: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        c + "…"
    } else {
        c
    }
}

/* =========================================================================== Excel */

struct XSheet {
    name: String,
    part: String,
}

fn xl_sheets(pkg: &Package) -> Result<Vec<XSheet>, String> {
    let wb = pkg.text("xl/workbook.xml").ok_or("This Excel file has no workbook part.")?;
    let rels = pkg.rels_of("xl/workbook.xml");
    let mut out = Vec::new();
    for k in tokens(&wb) {
        if let Tok::Open { name, raw, .. } = k {
            if local(name) == "sheet" {
                let n = attr(raw, "name").unwrap_or_default();
                let rid = attr(raw, "r:id").or_else(|| raw_attr_suffix(raw, ":id")).unwrap_or_default();
                if let Some((ty, target)) = rels.get(&rid) {
                    if ty.ends_with("/worksheet") {
                        out.push(XSheet { name: n, part: target.clone() });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// An attribute by the end of its name (a namespace prefix other than the usual one).
fn raw_attr_suffix(raw: &str, suffix: &str) -> Option<String> {
    let pieces: Vec<&str> = raw.split_whitespace().collect();
    for p in pieces {
        if let Some((k, _)) = p.split_once('=') {
            if k.ends_with(suffix) {
                return attr(raw, k);
            }
        }
    }
    None
}

fn shared_strings(pkg: &Package) -> Vec<String> {
    let Some(x) = pkg.text("xl/sharedStrings.xml") else { return Vec::new() };
    let t = tokens(&x);
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if let Tok::Open { name, empty, .. } = t[i] {
            if local(name) == "si" {
                let end = close_of(&t, i);
                let mut s = String::new();
                if !empty {
                    let mut k = i + 1;
                    while k < end {
                        if let Tok::Open { name: n, empty: false, .. } = t[k] {
                            if local(n) == "rPh" || local(n) == "phoneticPr" {
                                k = close_of(&t, k) + 1;
                                continue;
                            }
                            if local(n) == "t" {
                                s += &unescape(&x[open_end(&t, k)..close_start(&t, k)]);
                            }
                        }
                        k += 1;
                    }
                }
                out.push(s);
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[derive(Clone, Debug)]
struct XCell {
    col: u32,
    raw: String,
}

#[derive(Clone, Debug)]
struct XRow {
    r: u32,
    open: String, // the <row ...> tag, without r / spans (written again)
    cells: Vec<XCell>,
}

struct SheetData {
    rows: Vec<XRow>,
    start: usize, // byte range of the whole <sheetData> element
    end: usize,
}

fn parse_sheet_data(x: &str) -> Result<SheetData, String> {
    let t = tokens(x);
    let sd = t.iter().position(|k| matches!(k, Tok::Open { name, .. } if local(name) == "sheetData")).ok_or("This sheet has no data part.")?;
    let (start, end) = span(&t, sd);
    let mut rows = Vec::new();
    let close = close_of(&t, sd);
    let mut i = sd + 1;
    let mut next_r = 1u32;
    while i < close {
        if let Tok::Open { name, raw, .. } = t[i] {
            if local(name) == "row" {
                let r = attr(raw, "r").and_then(|v| v.parse().ok()).unwrap_or(next_r);
                next_r = r + 1;
                let rc = close_of(&t, i);
                let mut cells = Vec::new();
                let mut k = i + 1;
                let mut next_c = 1u32;
                while k < rc {
                    if let Tok::Open { name: n, raw: craw, .. } = t[k] {
                        if local(n) == "c" {
                            let col = attr(craw, "r").and_then(|v| cell_ref(&v)).map(|(c, _)| c).unwrap_or(next_c);
                            next_c = col + 1;
                            let (s, e) = span(&t, k);
                            let mut raw_cell = x[s..e].to_string();
                            if attr(craw, "r").is_none() {
                                let fixed = set_attr(craw, "r", &format!("{}{}", col_name(col), r));
                                raw_cell = fixed + &raw_cell[craw.len()..];
                            }
                            cells.push(XCell { col, raw: raw_cell });
                            k = close_of(&t, k) + 1;
                            continue;
                        }
                    }
                    k += 1;
                }
                let open = strip_attrs(raw, &["r", "spans"]);
                rows.push(XRow { r, open, cells });
                i = rc + 1;
                continue;
            }
        }
        i += 1;
    }
    Ok(SheetData { rows, start, end })
}

/// The tag without some attributes, as an opening tag (never self-closing).
fn strip_attrs(raw: &str, names: &[&str]) -> String {
    let inner = raw.trim_start_matches('<').trim_end_matches('>').trim_end_matches('/');
    let mut parts: Vec<String> = Vec::new();
    let b = inner.as_bytes();
    let mut i = 0;
    let name_end = inner.find(char::is_whitespace).unwrap_or(inner.len());
    parts.push(inner[..name_end].to_string());
    i += name_end;
    while i < b.len() {
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let ks = i;
        while i < b.len() && b[i] != b'=' && !(b[i] as char).is_whitespace() {
            i += 1;
        }
        let key = &inner[ks..i];
        while i < b.len() && (b[i] == b'=' || (b[i] as char).is_whitespace()) {
            i += 1;
        }
        if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
            let q = b[i];
            let vs = i;
            i += 1;
            while i < b.len() && b[i] != q {
                i += 1;
            }
            i += 1;
            if !names.contains(&key) {
                parts.push(format!("{key}={}", &inner[vs..i.min(inner.len())]));
            }
        }
    }
    format!("<{}>", parts.join(" "))
}

fn cell_value_text(raw: &str, ss: &[String]) -> (String, Option<String>) {
    let t = tokens(raw);
    let open = match t.first() {
        Some(Tok::Open { raw, .. }) => *raw,
        _ => return (String::new(), None),
    };
    let ty = attr(open, "t").unwrap_or_default();
    let mut v = None;
    let mut f = None;
    let mut is_text = String::new();
    let mut in_is = false;
    for (k, tok) in t.iter().enumerate() {
        match tok {
            Tok::Open { name, empty: false, .. } if local(name) == "v" => v = Some(unescape(&raw[open_end(&t, k)..close_start(&t, k)])),
            Tok::Open { name, empty: false, .. } if local(name) == "f" => f = Some(unescape(&raw[open_end(&t, k)..close_start(&t, k)])),
            Tok::Open { name, empty: false, .. } if local(name) == "is" => in_is = true,
            Tok::Open { name, empty: false, .. } if local(name) == "t" && in_is => is_text += &unescape(&raw[open_end(&t, k)..close_start(&t, k)]),
            _ => {}
        }
    }
    let shown = match ty.as_str() {
        "s" => v.and_then(|i| i.trim().parse::<usize>().ok()).and_then(|i| ss.get(i).cloned()).unwrap_or_default(),
        "inlineStr" => is_text,
        "b" => match v.as_deref() {
            Some("1") => "TRUE".into(),
            Some(_) => "FALSE".into(),
            None => String::new(),
        },
        _ => v.unwrap_or_default(),
    };
    (shown, f)
}

pub fn xlsx_read(pkg: &Package, sheet: Option<&str>, range: Option<&str>, max_chars: usize) -> Result<String, String> {
    let sheets = xl_sheets(pkg)?;
    let ss = shared_strings(pkg);
    let bounds = match range {
        Some(r) if !r.trim().is_empty() => {
            let (a, b) = r.split_once(':').unwrap_or((r, r));
            let (c1, r1) = cell_ref(a).ok_or("range is like \"A1:D20\".")?;
            let (c2, r2) = cell_ref(b).ok_or("range is like \"A1:D20\".")?;
            Some((c1.min(c2), r1.min(r2), c1.max(c2), r1.max(r2)))
        }
        _ => None,
    };
    let mut out = format!("Sheets: {}\n", sheets.iter().map(|s| format!("\"{}\"", s.name)).collect::<Vec<_>>().join(", "));
    let chosen: Vec<&XSheet> = match sheet {
        Some(n) if !n.trim().is_empty() => vec![sheets.iter().find(|s| s.name.eq_ignore_ascii_case(n.trim())).ok_or_else(|| format!("There is no sheet \"{n}\" (sheets: {}).", sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")))?],
        _ => sheets.iter().collect(),
    };
    'sheets: for s in chosen {
        let x = pkg.text(&s.part).ok_or_else(|| format!("The sheet \"{}\" has no data.", s.name))?;
        let sd = parse_sheet_data(&x)?;
        out += &format!("\n## {}\n", s.name);
        let mut n = 0;
        for row in &sd.rows {
            let mut line = String::new();
            for c in &row.cells {
                if let Some((c1, r1, c2, r2)) = bounds {
                    if c.col < c1 || c.col > c2 || row.r < r1 || row.r > r2 {
                        continue;
                    }
                }
                let (v, f) = cell_value_text(&c.raw, &ss);
                if v.is_empty() && f.is_none() {
                    continue;
                }
                n += 1;
                let mut cell = format!("{}{}: {}", col_name(c.col), row.r, v.replace('\n', " "));
                if let Some(f) = f {
                    cell += &format!(" (={f})");
                }
                if !line.is_empty() {
                    line += " | ";
                }
                line += &cell;
            }
            if line.is_empty() {
                continue;
            }
            line.push('\n');
            if out.len() + line.len() > max_chars {
                out += &format!("… (cut at {max_chars} characters: read a range, e.g. range \"A1:H50\")\n");
                break 'sheets;
            }
            out += &line;
        }
        if n == 0 {
            out += "(no values)\n";
        }
    }
    Ok(out)
}

/// One new cell's XML for a JSON value (style `s` kept).
fn new_cell(col: u32, row: u32, style: Option<&str>, v: &Value) -> Result<String, String> {
    let r = format!("{}{}", col_name(col), row);
    let s = style.map(|s| format!(" s=\"{}\"", esc(s))).unwrap_or_default();
    Ok(match v {
        Value::Null => format!("<c r=\"{r}\"{s}/>"),
        Value::Bool(b) => format!("<c r=\"{r}\"{s} t=\"b\"><v>{}</v></c>", if *b { 1 } else { 0 }),
        Value::Number(n) => {
            let f = n.as_f64().filter(|f| f.is_finite()).ok_or("A number in values is not finite.")?;
            let _ = f;
            format!("<c r=\"{r}\"{s}><v>{}</v></c>", n)
        }
        Value::String(t) if t.starts_with('=') && t.len() > 1 => format!("<c r=\"{r}\"{s}><f>{}</f></c>", esc(&t[1..])),
        Value::String(t) => {
            if t.chars().count() > 32_767 {
                return Err("A cell holds at most 32,767 characters.".into());
            }
            format!("<c r=\"{r}\"{s} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>", esc(t))
        }
        other => format!("<c r=\"{r}\"{s} t=\"inlineStr\"><is><t>{}</t></is></c>", esc(&other.to_string())),
    })
}

fn render_sheet_data(rows: &[XRow]) -> String {
    let mut s = String::from("<sheetData>");
    for row in rows {
        let open = row.open.trim_end_matches('>');
        s += &format!("{open} r=\"{}\">", row.r);
        for c in &row.cells {
            s += &c.raw;
        }
        s += "</row>";
    }
    s + "</sheetData>"
}

fn xlsx_set_cells(x: &str, top_left: (u32, u32), values: &[Vec<Value>]) -> Result<(String, usize), String> {
    let mut sd = parse_sheet_data(x)?;
    let mut n = 0;
    for (dr, rowv) in values.iter().enumerate() {
        let r = top_left.1 + dr as u32;
        if r > 1_048_576 {
            return Err("The values run past the last row of a sheet.".into());
        }
        let ri = match sd.rows.iter().position(|q| q.r >= r) {
            Some(k) if sd.rows[k].r == r => k,
            Some(k) => {
                sd.rows.insert(k, XRow { r, open: "<row>".into(), cells: Vec::new() });
                k
            }
            None => {
                sd.rows.push(XRow { r, open: "<row>".into(), cells: Vec::new() });
                sd.rows.len() - 1
            }
        };
        for (dc, v) in rowv.iter().enumerate() {
            let c = top_left.0 + dc as u32;
            if c > 16_384 {
                return Err("The values run past the last column of a sheet.".into());
            }
            let row = &mut sd.rows[ri];
            let existing = row.cells.iter().position(|q| q.col == c);
            let style = existing.and_then(|k| {
                let t = tokens(&row.cells[k].raw);
                match t.first() {
                    Some(Tok::Open { raw, .. }) => attr(raw, "s"),
                    _ => None,
                }
            });
            if let Some(k) = existing {
                let raw = &row.cells[k].raw;
                if raw.contains("t=\"shared\"") && raw.contains("ref=") || raw.contains("t=\"array\"") {
                    return Err(format!("{}{} starts a shared or array formula that other cells use; change it with Office (engine \"office\") or pick other cells.", col_name(c), r));
                }
            }
            let cell = XCell { col: c, raw: new_cell(c, r, style.as_deref(), v)? };
            match existing {
                Some(k) => row.cells[k] = cell,
                None => {
                    let at = row.cells.iter().position(|q| q.col > c).unwrap_or(row.cells.len());
                    row.cells.insert(at, cell);
                }
            }
            n += 1;
        }
    }
    let mut out = String::with_capacity(x.len() + 256);
    out.push_str(&x[..sd.start]);
    out.push_str(&render_sheet_data(&sd.rows));
    out.push_str(&x[sd.end..]);
    // The used range.
    let (mut c1, mut r1, mut c2, mut r2) = (u32::MAX, u32::MAX, 0, 0);
    for row in &sd.rows {
        for c in &row.cells {
            c1 = c1.min(c.col);
            c2 = c2.max(c.col);
            r1 = r1.min(row.r);
            r2 = r2.max(row.r);
        }
    }
    if c2 > 0 {
        let dim = if (c1, r1) == (c2, r2) { format!("{}{}", col_name(c1), r1) } else { format!("{}{}:{}{}", col_name(c1), r1, col_name(c2), r2) };
        let t = tokens(&out);
        if let Some(Tok::Open { raw, start, end, .. }) = t.iter().find(|k| matches!(k, Tok::Open { name, .. } if local(name) == "dimension")).cloned() {
            let new = set_attr(raw, "ref", &dim);
            out.replace_range(start..end, &new);
        }
    }
    Ok((out, n))
}

/// After cells change: drop the calculation chain (it may name cells that no longer hold formulas)
/// and ask Excel to recalculate everything when the file is opened.
fn xlsx_after_change(pkg: &mut Package) {
    let wb_rels = rels_name("xl/workbook.xml");
    if let Some(r) = pkg.text(&wb_rels) {
        let t = tokens(&r);
        let mut edits = Vec::new();
        for (i, k) in t.iter().enumerate() {
            if let Tok::Open { name, raw, .. } = k {
                if local(name) == "Relationship" && attr(raw, "Type").map(|ty| ty.ends_with("/calcChain")).unwrap_or(false) {
                    let (s, e) = span(&t, i);
                    edits.push((s, e, String::new()));
                }
            }
        }
        if !edits.is_empty() {
            pkg.put(&wb_rels, splice(&r, edits));
        }
    }
    if pkg.has("xl/calcChain.xml") {
        pkg.remove("xl/calcChain.xml");
        remove_override(pkg, "/xl/calcChain.xml");
    }
    if let Some(wb) = pkg.text("xl/workbook.xml") {
        let t = tokens(&wb);
        let new = if let Some(Tok::Open { raw, start, end, .. }) = t.iter().find(|k| matches!(k, Tok::Open { name, .. } if local(name) == "calcPr")).cloned() {
            let mut w = wb.clone();
            w.replace_range(start..end, &set_attr(raw, "fullCalcOnLoad", "1"));
            w
        } else {
            // calcPr comes after sheets / functionGroups / externalReferences / definedNames.
            let after = ["definedNames", "externalReferences", "functionGroups", "sheets"].iter().find_map(|n| {
                t.iter().enumerate().find(|(_, k)| matches!(k, Tok::Open { name, .. } if local(name) == *n)).map(|(i, _)| span(&t, i).1)
            });
            match after {
                Some(at) => splice(&wb, vec![(at, at, "<calcPr fullCalcOnLoad=\"1\"/>".into())]),
                None => wb.clone(),
            }
        };
        pkg.put("xl/workbook.xml", new);
    }
}

fn remove_override(pkg: &mut Package, part_name: &str) {
    if let Some(ct) = pkg.text("[Content_Types].xml") {
        let t = tokens(&ct);
        let mut edits = Vec::new();
        for (i, k) in t.iter().enumerate() {
            if let Tok::Open { name, raw, .. } = k {
                if local(name) == "Override" && attr(raw, "PartName").map(|p| p.eq_ignore_ascii_case(part_name)).unwrap_or(false) {
                    let (s, e) = span(&t, i);
                    edits.push((s, e, String::new()));
                }
            }
        }
        if !edits.is_empty() {
            pkg.put("[Content_Types].xml", splice(&ct, edits));
        }
    }
}

fn add_override(pkg: &mut Package, part_name: &str, content_type: &str) -> Result<(), String> {
    let ct = pkg.text("[Content_Types].xml").ok_or("The file has no content types part.")?;
    let at = ct.rfind("</Types>").ok_or("The content types part is not readable.")?;
    let new = splice(&ct, vec![(at, at, format!("<Override PartName=\"{}\" ContentType=\"{}\"/>", esc(part_name), esc(content_type)))]);
    pkg.put("[Content_Types].xml", new);
    Ok(())
}

/// Add a relationship to a part's rels (made when missing): its new id.
fn add_rel(pkg: &mut Package, part: &str, ty: &str, target: &str) -> String {
    let rn = rels_name(part);
    let x = pkg.text(&rn).unwrap_or_else(|| "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".into());
    let mut n = 1;
    while x.contains(&format!("Id=\"rId{n}\"")) {
        n += 1;
    }
    let id = format!("rId{n}");
    let at = x.rfind("</Relationships>").unwrap_or(x.len());
    let new = if x.contains("</Relationships>") {
        splice(&x, vec![(at, at, format!("<Relationship Id=\"{id}\" Type=\"{}\" Target=\"{}\"/>", esc(ty), esc(target)))])
    } else {
        // <Relationships .../> (empty): open it.
        x.replace("/>", &format!("><Relationship Id=\"{id}\" Type=\"{}\" Target=\"{}\"/></Relationships>", esc(ty), esc(target)))
    };
    pkg.put(&rn, new);
    id
}

fn remove_rel(pkg: &mut Package, part: &str, id: &str) {
    let rn = rels_name(part);
    if let Some(x) = pkg.text(&rn) {
        let t = tokens(&x);
        let mut edits = Vec::new();
        for (i, k) in t.iter().enumerate() {
            if let Tok::Open { name, raw, .. } = k {
                if local(name) == "Relationship" && attr(raw, "Id").as_deref() == Some(id) {
                    let (s, e) = span(&t, i);
                    edits.push((s, e, String::new()));
                }
            }
        }
        pkg.put(&rn, splice(&x, edits));
    }
}

const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn xlsx_add_sheet(pkg: &mut Package, name: &str, rows: &[Vec<Value>]) -> Result<(), String> {
    let sheets = xl_sheets(pkg)?;
    if sheets.iter().any(|s| s.name.to_lowercase() == name.to_lowercase()) {
        return Err(format!("There is already a sheet \"{name}\"."));
    }
    let mut n = 1;
    while pkg.has(&format!("xl/worksheets/sheet{n}.xml")) {
        n += 1;
    }
    let part = format!("xl/worksheets/sheet{n}.xml");
    let mut body = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><dimension ref=\"A1\"/><sheetData/></worksheet>");
    if !rows.is_empty() {
        body = xlsx_set_cells(&body, (1, 1), rows)?.0;
    }
    pkg.put(&part, body);
    add_override(pkg, &format!("/{part}"), "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")?;
    let rid = add_rel(pkg, "xl/workbook.xml", &format!("{R_NS}/worksheet"), &format!("worksheets/sheet{n}.xml"));
    let wb = pkg.text("xl/workbook.xml").ok_or("This Excel file has no workbook part.")?;
    let t = tokens(&wb);
    let mut max_id = 0u32;
    let mut sheets_close = None;
    let mut sheets_empty = None;
    for (i, k) in t.iter().enumerate() {
        match k {
            Tok::Open { name, raw, .. } if local(name) == "sheet" => max_id = max_id.max(attr(raw, "sheetId").and_then(|v| v.parse().ok()).unwrap_or(0)),
            Tok::Open { name, empty: true, start, end, .. } if local(name) == "sheets" => sheets_empty = Some((*start, *end)),
            Tok::Close { name, start, .. } if local(name) == "sheets" => sheets_close = Some(*start),
            _ => {}
        }
        let _ = i;
    }
    let prefix = t.iter().find_map(|k| match k {
        Tok::Open { name, .. } if local(name) == "sheets" => Some(name.strip_suffix("sheets").unwrap_or("").to_string()),
        _ => None,
    });
    let pre = prefix.unwrap_or_default();
    let el = format!("<{pre}sheet name=\"{}\" sheetId=\"{}\" r:id=\"{rid}\"/>", esc(name), max_id + 1);
    let new = if let Some(at) = sheets_close {
        splice(&wb, vec![(at, at, el)])
    } else if let Some((s, e)) = sheets_empty {
        splice(&wb, vec![(s, e, format!("<{pre}sheets>{el}</{pre}sheets>"))])
    } else {
        return Err("The workbook has no list of sheets.".into());
    };
    // The r: prefix must be declared on the workbook (Excel always does).
    if !new.contains("xmlns:r=") {
        return Err("The workbook's relationships namespace is not where expected; use Office (engine \"office\").".into());
    }
    pkg.put("xl/workbook.xml", new);
    Ok(())
}

fn xlsx_edit(pkg: &mut Package, ops: &[Op]) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    for op in ops {
        match op {
            Op::SetCells { sheet, cell, values } => {
                let sheets = xl_sheets(pkg)?;
                let s = match sheet.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(n) => sheets.iter().find(|s| s.name.eq_ignore_ascii_case(n)).ok_or_else(|| format!("There is no sheet \"{n}\" (sheets: {}).", sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")))?,
                    None => sheets.first().ok_or("The workbook has no sheets.")?,
                };
                let x = pkg.text(&s.part).ok_or_else(|| format!("The sheet \"{}\" has no data.", s.name))?;
                let (new, n) = xlsx_set_cells(&x, cell_ref(cell).ok_or("cell is like \"B2\".")?, values)?;
                pkg.put(&s.part.clone(), new);
                xlsx_after_change(pkg);
                notes.push(format!("{n} cell(s) set on \"{}\" from {cell}", s.name));
            }
            Op::AddSheet { name, rows } => {
                xlsx_add_sheet(pkg, name, rows)?;
                if !rows.is_empty() {
                    xlsx_after_change(pkg);
                }
                notes.push(format!("sheet \"{name}\" added"));
            }
            _ => return Err("That edit is not for an Excel file.".into()),
        }
    }
    Ok(notes)
}

/* =========================================================================== PowerPoint */

struct PSlide {
    part: String,
    rid: String,
}

fn ppt_slides(pkg: &Package) -> Result<Vec<PSlide>, String> {
    let p = pkg.text("ppt/presentation.xml").ok_or("This PowerPoint file has no presentation part.")?;
    let rels = pkg.rels_of("ppt/presentation.xml");
    let mut out = Vec::new();
    for k in tokens(&p) {
        if let Tok::Open { name, raw, .. } = k {
            if local(name) == "sldId" {
                let rid = attr(raw, "r:id").or_else(|| raw_attr_suffix(raw, ":id")).unwrap_or_default();
                if let Some((_, target)) = rels.get(&rid) {
                    out.push(PSlide { part: target.clone(), rid });
                }
            }
        }
    }
    Ok(out)
}

/// A shape's role: "title", "body" or "" (other), from its placeholder.
fn ph_role(t: &[Tok], sp: usize) -> &'static str {
    let end = close_of(t, sp);
    for k in &t[sp..end] {
        if let Tok::Open { name, raw, .. } = k {
            if local(name) == "ph" {
                return match attr(raw, "type").as_deref() {
                    Some("title") | Some("ctrTitle") => "title",
                    Some("body") | Some("obj") | Some("subTitle") => "body",
                    None => "body", // idx only: the content placeholder
                    _ => "",
                };
            }
            if local(name) == "txBody" {
                break;
            }
        }
    }
    ""
}

struct PPara {
    texts: Vec<usize>, // token indices of <a:t>
}

/// The text paragraphs (a:p) of a part with their a:t nodes.
fn a_paras(t: &[Tok]) -> Vec<PPara> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if let Tok::Open { name, empty, .. } = t[i] {
            if name == "a:p" {
                let end = close_of(t, i);
                let mut texts = Vec::new();
                if !empty {
                    for k in i + 1..end {
                        if let Tok::Open { name: "a:t", empty: false, .. } = t[k] {
                            texts.push(k);
                        }
                    }
                }
                out.push(PPara { texts });
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn text_of_node(t: &[Tok], x: &str, k: usize) -> String {
    unescape(&x[open_end(t, k)..close_start(t, k)])
}

fn shapes_text(x: &str) -> (Option<String>, Vec<String>) {
    let t = tokens(x);
    let mut title = None;
    let mut others = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if let Tok::Open { name, .. } = t[i] {
            if name == "p:sp" || name == "p:graphicFrame" {
                let end = close_of(&t, i);
                let role = if name == "p:sp" { ph_role(&t, i) } else { "" };
                let sub = &t[i..=end];
                let lines: Vec<String> = a_paras(sub).iter().map(|p| p.texts.iter().map(|&k| text_of_node(sub, x, k)).collect::<String>()).filter(|s| !s.trim().is_empty()).collect();
                if role == "title" && title.is_none() {
                    title = Some(lines.join(" "));
                } else {
                    others.extend(lines);
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    (title, others)
}

fn notes_part(pkg: &Package, slide_part: &str) -> Option<String> {
    pkg.rels_of(slide_part).values().find(|(ty, _)| ty.ends_with("/notesSlide")).map(|(_, p)| p.clone())
}

pub fn pptx_read(pkg: &Package, max_chars: usize) -> Result<String, String> {
    let slides = ppt_slides(pkg)?;
    let mut out = format!("{} slides:\n", slides.len());
    for (i, s) in slides.iter().enumerate() {
        let x = pkg.text(&s.part).unwrap_or_default();
        let (title, lines) = shapes_text(&x);
        let mut block = format!("\n[slide {}] {}\n", i + 1, title.unwrap_or_else(|| "(no title)".into()));
        for l in lines {
            block += &format!("  - {}\n", l);
        }
        if let Some(np) = notes_part(pkg, &s.part) {
            let nx = pkg.text(&np).unwrap_or_default();
            let t = tokens(&nx);
            let mut notes = Vec::new();
            let mut k = 0;
            while k < t.len() {
                if let Tok::Open { name: "p:sp", .. } = t[k] {
                    let end = close_of(&t, k);
                    if ph_role(&t, k) == "body" {
                        let sub = &t[k..=end];
                        notes.extend(a_paras(sub).iter().map(|p| p.texts.iter().map(|&q| text_of_node(sub, &nx, q)).collect::<String>()));
                    }
                    k = end + 1;
                    continue;
                }
                k += 1;
            }
            let n = notes.join(" ").trim().to_string();
            if !n.is_empty() {
                block += &format!("  notes: {}\n", n);
            }
        }
        if out.len() + block.len() > max_chars {
            out += &format!("… (cut at {max_chars} characters)\n");
            break;
        }
        out += &block;
    }
    Ok(out)
}

fn a_para_xml(text: &str) -> String {
    let rtl = super::docs::mostly_arabic(text);
    let ppr = if rtl { "<a:pPr rtl=\"1\"/>" } else { "" };
    if text.is_empty() {
        return format!("<a:p>{ppr}<a:endParaRPr lang=\"en-US\" dirty=\"0\"/></a:p>");
    }
    format!("<a:p>{ppr}<a:r><a:rPr lang=\"{}\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>", if rtl { "ar-EG" } else { "en-US" }, esc(&text.replace('\n', " ")))
}

/// Replace a txBody's paragraphs (keeping a:bodyPr and a:lstStyle).
fn set_txbody(x: &str, t: &[Tok], sp: usize, lines: &[String]) -> Option<(usize, usize, String)> {
    let end = close_of(t, sp);
    let tb = (sp..end).find(|&k| matches!(t[k], Tok::Open { name, .. } if local(name) == "txBody"))?;
    let tb_end = close_of(t, tb);
    let first_p = (tb..tb_end).find(|&k| matches!(t[k], Tok::Open { name: "a:p", .. }));
    let paras: String = if lines.is_empty() { a_para_xml("") } else { lines.iter().map(|l| a_para_xml(l)).collect() };
    match first_p {
        Some(fp) => {
            let s = match t[fp] {
                Tok::Open { start, .. } => start,
                _ => return None,
            };
            let e = close_start(t, tb);
            Some((s, e, paras))
        }
        None => {
            let e = close_start(t, tb);
            let _ = x;
            Some((e, e, paras))
        }
    }
}

fn ppt_replace(x: &str, find: &str, with: &str, all: bool, match_case: bool, budget: &mut usize) -> (String, usize) {
    let t = tokens(x);
    let mut edits = Vec::new();
    let mut total = 0;
    for p in a_paras(&t) {
        if p.texts.is_empty() || *budget == 0 {
            continue;
        }
        let pieces: Vec<String> = p.texts.iter().map(|&k| text_of_node(&t, x, k)).collect();
        let (new, n) = replace_in_pieces(&pieces, find, &with.replace('\n', " "), all, match_case, budget);
        total += n;
        for (&k, (old, nt)) in p.texts.iter().zip(pieces.iter().zip(new)) {
            if &nt != old {
                edits.push((open_end(&t, k), close_start(&t, k), esc(&nt)));
            }
        }
    }
    (splice(x, edits), total)
}

fn pptx_edit(pkg: &mut Package, ops: &[Op]) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    for op in ops {
        let slides = ppt_slides(pkg)?;
        let get = |n: usize| slides.get(n.wrapping_sub(1)).ok_or_else(|| format!("There is no slide {n} (the deck has {}).", slides.len()));
        match op {
            Op::Replace { find, with, all, match_case, slide } => {
                let targets: Vec<&PSlide> = match slide {
                    Some(n) => vec![get(*n)?],
                    None => slides.iter().collect(),
                };
                let mut total = 0;
                let mut budget = usize::MAX;
                for s in targets {
                    let x = pkg.text(&s.part).unwrap_or_default();
                    let (new, n) = ppt_replace(&x, find, with, *all, *match_case, &mut budget);
                    if n > 0 {
                        pkg.put(&s.part, new);
                        total += n;
                    }
                    if budget == 0 {
                        break;
                    }
                }
                notes.push(format!("replaced \"{}\" {} time(s)", clip(find, 60), total));
            }
            Op::SetSlide { slide, title, bullets, notes: n } => {
                let s = get(*slide)?;
                let part = s.part.clone();
                let x = pkg.text(&part).unwrap_or_default();
                let t = tokens(&x);
                let mut edits = Vec::new();
                let sps: Vec<usize> = (0..t.len()).filter(|&k| matches!(t[k], Tok::Open { name: "p:sp", .. })).collect();
                if let Some(title) = title {
                    let sp = sps.iter().copied().find(|&k| ph_role(&t, k) == "title").ok_or_else(|| format!("Slide {slide} has no title box; use Office (engine \"office\") or add_slide."))?;
                    edits.push(set_txbody(&x, &t, sp, &[title.clone()]).ok_or("The title box has no text.")?);
                }
                if let Some(b) = bullets {
                    let sp = sps.iter().copied().find(|&k| ph_role(&t, k) == "body").ok_or_else(|| format!("Slide {slide} has no text box for bullets; use Office (engine \"office\")."))?;
                    edits.push(set_txbody(&x, &t, sp, b).ok_or("The text box has no text body.")?);
                }
                if !edits.is_empty() {
                    pkg.put(&part, splice(&x, edits));
                }
                let mut said = format!("slide {slide} set");
                if let Some(text) = n {
                    match notes_part(pkg, &part) {
                        Some(np) => {
                            let nx = pkg.text(&np).unwrap_or_default();
                            let nt = tokens(&nx);
                            let body = (0..nt.len()).find(|&k| matches!(nt[k], Tok::Open { name: "p:sp", .. }) && ph_role(&nt, k) == "body");
                            match body.and_then(|sp| set_txbody(&nx, &nt, sp, &text.lines().map(str::to_string).collect::<Vec<_>>())) {
                                Some(e) => pkg.put(&np, splice(&nx, vec![e])),
                                None => said += " (notes not changed: its notes page has no text box)",
                            }
                        }
                        None => said += " (notes not changed: the slide has no notes page; Office can add one, engine \"office\")",
                    }
                }
                notes.push(said);
            }
            Op::AddSlide { title, bullets, after } => {
                let pos = after.unwrap_or(slides.len()).min(slides.len());
                pptx_add_slide(pkg, &slides, pos, title, bullets)?;
                notes.push(format!("slide added as slide {}", pos + 1));
            }
            Op::DeleteSlide { slide } => {
                let s = get(*slide)?;
                let (part, rid) = (s.part.clone(), s.rid.clone());
                if slides.len() == 1 {
                    return Err("A deck keeps at least one slide.".into());
                }
                let p = pkg.text("ppt/presentation.xml").unwrap_or_default();
                let t = tokens(&p);
                let mut edits = Vec::new();
                for (i, k) in t.iter().enumerate() {
                    if let Tok::Open { name, raw, .. } = k {
                        if local(name) == "sldId" && (attr(raw, "r:id").as_deref() == Some(&rid) || raw_attr_suffix(raw, ":id").as_deref() == Some(&rid)) {
                            let (s, e) = span(&t, i);
                            edits.push((s, e, String::new()));
                        }
                    }
                }
                pkg.put("ppt/presentation.xml", splice(&p, edits));
                remove_rel(pkg, "ppt/presentation.xml", &rid);
                if let Some(np) = notes_part(pkg, &part) {
                    pkg.remove(&np);
                    pkg.remove(&rels_name(&np));
                    remove_override(pkg, &format!("/{np}"));
                }
                pkg.remove(&part);
                pkg.remove(&rels_name(&part));
                remove_override(pkg, &format!("/{part}"));
                notes.push(format!("slide {slide} deleted"));
            }
            _ => return Err("That edit is not for a PowerPoint file.".into()),
        }
    }
    Ok(notes)
}

/// The layout a new slide uses: "Title and Content" (type obj), else "Text" (tx), else the one the
/// slide before it uses.
fn pick_layout(pkg: &Package, slides: &[PSlide], pos: usize) -> Option<String> {
    let mut layouts: Vec<String> = pkg.names().into_iter().filter(|n| n.starts_with("ppt/slideLayouts/") && n.ends_with(".xml") && !n.contains("/_rels/")).collect();
    layouts.sort();
    for want in ["obj", "tx"] {
        for l in &layouts {
            let x = pkg.text(l).unwrap_or_default();
            if let Some(Tok::Open { raw, .. }) = tokens(&x).into_iter().find(|k| matches!(k, Tok::Open { name, .. } if local(name) == "sldLayout")) {
                if attr(raw, "type").as_deref() == Some(want) {
                    return Some(l.clone());
                }
            }
        }
    }
    let near = if pos > 0 { slides.get(pos - 1) } else { slides.first() };
    near.and_then(|s| pkg.rels_of(&s.part).values().find(|(ty, _)| ty.ends_with("/slideLayout")).map(|(_, p)| p.clone())).or_else(|| layouts.first().cloned())
}

fn rel_target(from_part: &str, to_part: &str) -> String {
    let from: Vec<&str> = from_part.split('/').collect();
    let to: Vec<&str> = to_part.split('/').collect();
    let dir = &from[..from.len() - 1];
    let mut common = 0;
    while common < dir.len() && common < to.len() - 1 && dir[common] == to[common] {
        common += 1;
    }
    let mut s = String::new();
    for _ in common..dir.len() {
        s += "../";
    }
    s + &to[common..].join("/")
}

fn pptx_add_slide(pkg: &mut Package, slides: &[PSlide], pos: usize, title: &str, bullets: &[String]) -> Result<(), String> {
    let layout = pick_layout(pkg, slides, pos).ok_or("The deck has no slide layout to build a slide on; use Office (engine \"office\").")?;
    let mut n = 1;
    while pkg.has(&format!("ppt/slides/slide{n}.xml")) {
        n += 1;
    }
    let part = format!("ppt/slides/slide{n}.xml");
    let title_sp = format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Title 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"title\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{}</p:txBody></p:sp>",
        a_para_xml(title)
    );
    let body_sp = if bullets.is_empty() {
        String::new()
    } else {
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Content Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{}</p:txBody></p:sp>",
            bullets.iter().map(|b| a_para_xml(b)).collect::<String>()
        )
    };
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"{R_NS}\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{title_sp}{body_sp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    );
    pkg.put(&part, xml);
    pkg.put(
        &rels_name(&part),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{R_NS}/slideLayout\" Target=\"{}\"/></Relationships>",
            esc(&rel_target(&part, &layout))
        ),
    );
    add_override(pkg, &format!("/{part}"), "application/vnd.openxmlformats-officedocument.presentationml.slide+xml")?;
    let rid = add_rel(pkg, "ppt/presentation.xml", &format!("{R_NS}/slide"), &format!("slides/slide{n}.xml"));
    let p = pkg.text("ppt/presentation.xml").ok_or("No presentation part.")?;
    let t = tokens(&p);
    let mut max_id = 255u32;
    let mut ids: Vec<(usize, usize)> = Vec::new(); // (start, end) of each sldId
    let mut list_close = None;
    let mut list_empty = None;
    for (i, k) in t.iter().enumerate() {
        match k {
            Tok::Open { name, raw, .. } if local(name) == "sldId" => {
                max_id = max_id.max(attr(raw, "id").and_then(|v| v.parse().ok()).unwrap_or(0));
                ids.push(span(&t, i));
            }
            Tok::Open { name, empty: true, start, end, .. } if local(name) == "sldIdLst" => list_empty = Some((*start, *end)),
            Tok::Close { name, start, .. } if local(name) == "sldIdLst" => list_close = Some(*start),
            _ => {}
        }
    }
    let el = format!("<p:sldId id=\"{}\" r:id=\"{rid}\"/>", max_id + 1);
    let new = if pos < ids.len() {
        let at = ids[pos].0;
        splice(&p, vec![(at, at, el)])
    } else if let Some(at) = list_close {
        splice(&p, vec![(at, at, el)])
    } else if let Some((s, e)) = list_empty {
        splice(&p, vec![(s, e, format!("<p:sldIdLst>{el}</p:sldIdLst>"))])
    } else {
        // No list at all: after the masters' lists.
        let after = ["handoutMasterIdLst", "notesMasterIdLst", "sldMasterIdLst"].iter().find_map(|nm| t.iter().enumerate().find(|(_, k)| matches!(k, Tok::Open { name, .. } if local(name) == *nm)).map(|(i, _)| span(&t, i).1));
        let at = after.ok_or("The presentation has no slide list.")?;
        splice(&p, vec![(at, at, format!("<p:sldIdLst>{el}</p:sldIdLst>"))])
    };
    pkg.put("ppt/presentation.xml", new);
    Ok(())
}

/* =========================================================================== entry points */

/// Text for the model: paragraphs / cells / slides, numbered for the edits.
pub fn read(kind: Office, bytes: &[u8], sheet: Option<&str>, range: Option<&str>, max_chars: usize) -> Result<String, String> {
    let pkg = Package::open(bytes)?;
    match kind {
        Office::Docx => docx_read(&pkg, max_chars),
        Office::Xlsx => xlsx_read(&pkg, sheet, range, max_chars),
        Office::Pptx => pptx_read(&pkg, max_chars),
        Office::Pdf => Err("Read PDFs with pdf_read.".into()),
    }
}

/// Apply the edits; the new file's bytes and a note per edit. Refuses macro-enabled packages.
pub fn edit(kind: Office, bytes: &[u8], ops: &[Op]) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut pkg = Package::open(bytes)?;
    if pkg.has_macros() {
        return Err("This file contains macros: JOYA AI does not edit files with macros.".into());
    }
    let notes = match kind {
        Office::Docx => docx_edit(&mut pkg, ops)?,
        Office::Xlsx => xlsx_edit(&mut pkg, ops)?,
        Office::Pptx => pptx_edit(&mut pkg, ops)?,
        Office::Pdf => return Err("PDFs are not edited; use pdf_merge or export a new one.".into()),
    };
    Ok((pkg.save()?, notes))
}

pub fn has_macros(bytes: &[u8]) -> bool {
    Package::open(bytes).map(|p| p.has_macros()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hands::docs;

    fn docx_fixture() -> Vec<u8> {
        let blocks = docs::parse_blocks(Some(&json!([{"h1": "Quarterly report 2025"}, "Sales rose in 2025.", {"bullet": ["North", "South"]}, {"table": [["Region", "2025"], ["North", "12"]]}, "مرحبا بكم في 2025"]))).unwrap();
        docs::build_docx("Report", &blocks).unwrap()
    }

    #[test]
    fn scanner() {
        let x = "<?xml version=\"1.0\"?><a b=\"1 > 2\" c='x'><b/>t&amp;x<!-- c --></a>";
        let t = tokens(x);
        assert!(matches!(t[1], Tok::Open { name: "a", empty: false, .. }));
        assert_eq!(attr(match t[1] { Tok::Open { raw, .. } => raw, _ => "" }, "b").as_deref(), Some("1 > 2"));
        assert!(matches!(t[2], Tok::Open { name: "b", empty: true, .. }));
        assert_eq!(close_of(&t, 1), t.len() - 1);
        assert_eq!(unescape("a&amp;b&lt;&#65;&#x42;&bogus;"), "a&b<AB&bogus;");
        assert_eq!(set_attr("<c r=\"A1\" s=\"2\">", "s", "5"), "<c r=\"A1\" s=\"5\">");
        assert_eq!(set_attr("<calcPr calcId=\"1\"/>", "fullCalcOnLoad", "1"), "<calcPr calcId=\"1\" fullCalcOnLoad=\"1\"/>");
        assert_eq!(strip_attrs("<row r=\"3\" spans=\"1:4\" ht=\"20\">", &["r", "spans"]), "<row ht=\"20\">");
        assert_eq!(join_part("xl", "worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
        assert_eq!(join_part("ppt/slides", "../slideLayouts/slideLayout1.xml"), "ppt/slideLayouts/slideLayout1.xml");
        assert_eq!(join_part("xl", "/xl/worksheets/sheet2.xml"), "xl/worksheets/sheet2.xml");
        assert_eq!(rel_target("ppt/slides/slide3.xml", "ppt/slideLayouts/slideLayout2.xml"), "../slideLayouts/slideLayout2.xml");
    }

    #[test]
    fn pieces() {
        let p = vec!["Sales r".to_string(), "ose in 20".into(), "25.".into()];
        let mut b = usize::MAX;
        let (n, k) = replace_in_pieces(&p, "2025", "2026", true, true, &mut b);
        assert_eq!(k, 1);
        assert_eq!(n, vec!["Sales r", "ose in 2026", "."]);
        let mut b = usize::MAX;
        let (n, k) = replace_in_pieces(&["aXa".to_string(), "xA".into()], "xa", "-", true, false, &mut b);
        assert_eq!((n, k), (vec!["a-".to_string(), "-".into()], 2));
        let mut b = usize::MAX;
        let (_, k) = replace_in_pieces(&["a a a".to_string()], "a", "b", false, true, &mut b);
        assert_eq!(k, 1);
        assert_eq!(b, 0, "only the first when all is false");
    }

    #[test]
    fn cells() {
        assert_eq!(cell_ref("B12"), Some((2, 12)));
        assert_eq!(cell_ref("$AA$3"), Some((27, 3)));
        assert_eq!(cell_ref("XFD1048576"), Some((16384, 1048576)));
        assert_eq!(cell_ref("XFE1"), None);
        assert_eq!(cell_ref("A0"), None);
        assert_eq!(cell_ref("12"), None);
        assert_eq!(col_name(27), "AA");
        assert_eq!(col_name(16384), "XFD");
        assert!(sheet_name_ok("Q3 2026") && !sheet_name_ok("a/b") && !sheet_name_ok("") && !sheet_name_ok(&"x".repeat(32)));
    }

    #[test]
    fn ops_parsing() {
        let ops = parse_ops(Office::Docx, &json!([{"replace": {"find": "a", "with": "b"}}, {"insert_paragraph": {"text": "x", "style": "h2", "after": 3}}])).unwrap();
        assert_eq!(ops[0], Op::Replace { find: "a".into(), with: "b".into(), all: true, match_case: true, slide: None });
        assert_eq!(ops_json(&ops)[1]["style"], "heading 2");
        assert_eq!(ops_json(&ops)[1]["style_builtin"], -3);
        assert!(parse_ops(Office::Docx, &json!([{"set_cells": {"cell": "A1", "values": [[1]]}}])).unwrap_err().contains("not an edit for a Word file"));
        assert!(parse_ops(Office::Xlsx, &json!([{"set_cells": {"cell": "A0", "values": [[1]]}}])).is_err());
        assert!(parse_ops(Office::Xlsx, &json!([{"set_cells": {"cell": "B2:C3", "values": [[1, 2]]}}])).is_ok(), "a range's top-left");
        assert!(parse_ops(Office::Docx, &json!([{"replace": {"find": "", "with": "b"}}])).is_err());
        assert!(parse_ops(Office::Docx, &json!([])).is_err());
        assert!(parse_ops(Office::Docx, &json!([{"replace": {}, "x": 1}])).is_err(), "one key per edit");
        assert!(parse_ops(Office::Pptx, &json!([{"set_slide": {"slide": 1}}])).is_err());
        assert!(parse_ops(Office::Docx, &json!([{"insert_paragraph": {"text": "x", "style": "Fancy"}}])).is_err());
    }

    #[test]
    fn word_read_and_edit() {
        let f = docx_fixture();
        let txt = read(Office::Docx, &f, None, None, 100_000).unwrap();
        assert!(txt.contains("] (Heading1) Quarterly report 2025") || txt.contains("Quarterly report 2025"), "{txt}");
        assert!(txt.contains("(table) Region"), "{txt}");
        let paras = docx_paragraph_texts(&Package::open(&f).unwrap());
        let n0 = paras.len();
        let sales = paras.iter().position(|p| p == "Sales rose in 2025.").unwrap() + 1;
        let north = paras.iter().position(|p| p == "North").unwrap() + 1;
        let ops = parse_ops(
            Office::Docx,
            &json!([
                {"replace": {"find": "2025", "with": "2026"}},
                {"set_paragraph": {"index": sales, "text": "Sales rose & fell.\nSecond line"}},
                {"insert_paragraph": {"text": "Closing note", "style": "h2"}},
                {"delete_paragraph": {"index": north}},
                {"insert_paragraph": {"text": "Opening note", "after": 0}}
            ]),
        )
        .unwrap();
        let (out, notes) = edit(Office::Docx, &f, &ops).unwrap();
        assert!(notes[0].contains("4 time(s)"), "{notes:?}");
        let after = docx_paragraph_texts(&Package::open(&out).unwrap());
        assert_eq!(after.len(), n0 + 1, "+2 added, 1 deleted: {after:?}");
        assert_eq!(after[0], "Opening note");
        assert!(after.contains(&"Quarterly report 2026".to_string()), "{after:?}");
        assert_eq!(after[sales], "Sales rose & fell.Second line", "the line break is a w:br (shifted by the opening note)");
        assert!(!after.contains(&"North".to_string()) || after.iter().filter(|p| *p == "North").count() == 1, "the bullet North went (the table's North stays)");
        assert_eq!(after.last().unwrap(), "Closing note");
        assert!(after.iter().any(|p| p.contains("مرحبا بكم في 2026")));
        let doc = Package::open(&out).unwrap().text("word/document.xml").unwrap();
        assert!(doc.contains("<w:br/>") && doc.contains("&amp; fell."));
        assert!(doc.contains("<w:pStyle w:val=\"Heading2\"/>"), "the style id from styles.xml");
        // Closing note is before the body's sectPr.
        assert!(doc.find("Closing note").unwrap() < doc.rfind("<w:sectPr").unwrap_or(usize::MAX) || !doc.contains("<w:sectPr"));
        assert!(edit(Office::Docx, &f, &parse_ops(Office::Docx, &json!([{"set_paragraph": {"index": 999, "text": "x"}}])).unwrap()).unwrap_err().contains("no paragraph 999"));
    }

    #[test]
    fn word_table_cell_keeps_a_paragraph() {
        let f = docx_fixture();
        let paras = docx_paragraph_texts(&Package::open(&f).unwrap());
        let i = paras.iter().position(|p| p == "Region").unwrap() + 1;
        let (out, notes) = edit(Office::Docx, &f, &parse_ops(Office::Docx, &json!([{"delete_paragraph": {"index": i}}])).unwrap()).unwrap();
        assert!(notes[0].contains("emptied"));
        let after = docx_paragraph_texts(&Package::open(&out).unwrap());
        assert_eq!(after.len(), paras.len());
        assert_eq!(after[i - 1], "");
    }

    #[test]
    fn excel_read_and_edit() {
        let sheets = docs::parse_sheets(Some(&json!([{"name": "Sales", "rows": [["Region", "Q1", "Q2"], ["North", 10, 20], ["South", 5, 7]], "header": true}]))).unwrap();
        let f = docs::build_xlsx("Budget", &sheets).unwrap();
        let txt = read(Office::Xlsx, &f, None, None, 100_000).unwrap();
        assert!(txt.contains("Sheets: \"Sales\"") && txt.contains("A1: Region") && txt.contains("B2: 10"), "{txt}");
        let ops = parse_ops(Office::Xlsx, &json!([
            {"set_cells": {"sheet": "sales", "cell": "D1", "values": [["Total"], ["=SUM(B2:C2)"], ["=SUM(B3:C3)"]]}},
            {"set_cells": {"cell": "A5", "values": [["Note", true, null, 3.5]]}},
            {"set_cells": {"cell": "B2", "values": [[11]]}},
            {"add_sheet": {"name": "Notes", "rows": [["Checked by JOYA AI"]]}}
        ])).unwrap();
        let (out, notes) = edit(Office::Xlsx, &f, &ops).unwrap();
        assert_eq!(notes.len(), 4);
        let txt = read(Office::Xlsx, &out, None, None, 100_000).unwrap();
        assert!(txt.contains("D1: Total") && txt.contains("D2:  (=SUM(B2:C2))") && txt.contains("B2: 11") && txt.contains("A5: Note") && txt.contains("B5: TRUE") && txt.contains("D5: 3.5"), "{txt}");
        assert!(txt.contains("## Notes") && txt.contains("A1: Checked by JOYA AI"), "{txt}");
        let pkg = Package::open(&out).unwrap();
        assert!(pkg.text("xl/workbook.xml").unwrap().contains("fullCalcOnLoad=\"1\""));
        let s1 = pkg.text("xl/worksheets/sheet1.xml").unwrap();
        assert!(!s1.contains("<dimension") || s1.contains("<dimension ref=\"A1:D5\"/>"), "{s1}");
        // Row 4 does not exist: row 5 comes after row 3, in order.
        assert!(s1.find("r=\"3\"").unwrap() < s1.find("r=\"5\"").unwrap());
        assert!(read(Office::Xlsx, &out, Some("Nope"), None, 1000).is_err());
        let ranged = read(Office::Xlsx, &out, Some("Sales"), Some("A1:B2"), 100_000).unwrap();
        assert!(ranged.contains("B2: 11") && !ranged.contains("C2"), "{ranged}");
        assert!(edit(Office::Xlsx, &f, &parse_ops(Office::Xlsx, &json!([{"add_sheet": {"name": "SALES"}}])).unwrap()).unwrap_err().contains("already"));
    }

    #[test]
    fn excel_shared_formula_master_is_refused() {
        let x = "<worksheet xmlns=\"x\"><sheetData><row r=\"1\"><c r=\"A1\"><f t=\"shared\" ref=\"A1:A3\" si=\"0\">B1*2</f><v>2</v></c></row></sheetData></worksheet>";
        assert!(xlsx_set_cells(x, (1, 1), &[vec![json!(5)]]).unwrap_err().contains("shared"));
        // A row and cells written without r attributes get them.
        let y = "<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>";
        let (out, _) = xlsx_set_cells(y, (3, 1), &[vec![json!("x")]]).unwrap();
        assert!(out.contains("<c r=\"A1\"><v>1</v></c><c r=\"B1\"><v>2</v></c><c r=\"C1\" t=\"inlineStr\">"), "{out}");
    }

    #[test]
    fn powerpoint_read_and_edit() {
        let slides = docs::parse_slides(Some(&json!([{"title": "Plan 2025", "bullets": ["Grow 2025 sales", "Hire"], "notes": "Say hello"}, {"title": "Next", "bullets": ["Later"]}]))).unwrap();
        let f = docs::build_pptx("Deck", &slides).unwrap();
        let txt = read(Office::Pptx, &f, None, None, 100_000).unwrap();
        assert!(txt.contains("[slide 1] Plan 2025") && txt.contains("- Grow 2025 sales") && txt.contains("notes: Say hello"), "{txt}");
        let ops = parse_ops(Office::Pptx, &json!([
            {"replace": {"find": "2025", "with": "2026"}},
            {"set_slide": {"slide": 2, "title": "Then", "bullets": ["One", "Two"], "notes": "x"}},
            {"add_slide": {"title": "Added", "bullets": ["A", "B"], "after": 1}},
            {"set_slide": {"slide": 1, "notes": "Hello again"}}
        ])).unwrap();
        let (out, notes) = edit(Office::Pptx, &f, &ops).unwrap();
        assert!(notes[0].contains("2 time(s)"), "{notes:?}");
        let txt = read(Office::Pptx, &out, None, None, 100_000).unwrap();
        assert!(txt.contains("3 slides"), "{txt}");
        assert!(txt.contains("[slide 1] Plan 2026") && txt.contains("[slide 2] Added") && txt.contains("[slide 3] Then") && txt.contains("- Two") && txt.contains("notes: Hello again"), "{txt}");
        let (out2, _) = edit(Office::Pptx, &out, &parse_ops(Office::Pptx, &json!([{"delete_slide": {"slide": 2}}])).unwrap()).unwrap();
        let txt2 = read(Office::Pptx, &out2, None, None, 100_000).unwrap();
        assert!(txt2.contains("2 slides") && !txt2.contains("Added"), "{txt2}");
        let pkg = Package::open(&out2).unwrap();
        assert!(!pkg.text("[Content_Types].xml").unwrap().contains("/ppt/slides/slide3.xml"), "the deleted slide's content type is gone");
    }

    #[test]
    fn macros_are_refused() {
        let mut pkg = Package::open(&docx_fixture()).unwrap();
        pkg.put("word/vbaProject.bin", "x".into());
        let bytes = pkg.save().unwrap();
        assert!(has_macros(&bytes));
        assert!(edit(Office::Docx, &bytes, &parse_ops(Office::Docx, &json!([{"replace": {"find": "a", "with": "b"}}])).unwrap()).unwrap_err().contains("macros"));
        assert!(Package::open(b"not a zip").is_err());
    }

    /// Writes edited sample files for checking with python-docx / openpyxl on the build box:
    /// JOYA_DOCS_OUT=/tmp/x cargo test -- --ignored write_edited_samples
    #[test]
    #[ignore]
    fn write_edited_samples() {
        let dir = std::env::var("JOYA_DOCS_OUT").unwrap_or_else(|_| "/tmp/joya-edited".into());
        std::fs::create_dir_all(&dir).unwrap();
        let (d, _) = edit(Office::Docx, &docx_fixture(), &parse_ops(Office::Docx, &json!([{"replace": {"find": "2025", "with": "2026"}}, {"insert_paragraph": {"text": "Closing note", "style": "h2"}}, {"set_paragraph": {"index": 2, "text": "Line one\nLine two\twith a tab"}}])).unwrap()).unwrap();
        std::fs::write(format!("{dir}/edited.docx"), d).unwrap();
        let sheets = docs::parse_sheets(Some(&json!([{"name": "Sales", "rows": [["Region", "Q1", "Q2"], ["North", 10, 20]], "header": true}]))).unwrap();
        let (x, _) = edit(Office::Xlsx, &docs::build_xlsx("B", &sheets).unwrap(), &parse_ops(Office::Xlsx, &json!([{"set_cells": {"cell": "D1", "values": [["Total"], ["=SUM(B2:C2)"]]}}, {"add_sheet": {"name": "Notes", "rows": [["ok", 1]]}}])).unwrap()).unwrap();
        std::fs::write(format!("{dir}/edited.xlsx"), x).unwrap();
        let slides = docs::parse_slides(Some(&json!([{"title": "Plan 2025", "bullets": ["Grow"]}]))).unwrap();
        let (p, _) = edit(Office::Pptx, &docs::build_pptx("D", &slides).unwrap(), &parse_ops(Office::Pptx, &json!([{"add_slide": {"title": "Added", "bullets": ["A"]}}, {"replace": {"find": "2025", "with": "2026"}}])).unwrap()).unwrap();
        std::fs::write(format!("{dir}/edited.pptx"), p).unwrap();
    }
}
