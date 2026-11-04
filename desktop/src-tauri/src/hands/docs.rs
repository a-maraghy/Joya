//! create_document: Word, Excel, PowerPoint files written as plain OOXML in a zip, and the HTML a
//! PDF is printed from (Edge headless prints it on Windows). Pure: unit-tested in core-tests, and the
//! files are checked with python-docx / openpyxl / python-pptx on the build box.
//!
//! Content model (also in the tool's inputSchema):
//!   docx / pdf: blocks: [{h1|h2|h3|p|bullet|numbered: text} | {table: [[cell]]}]   (a bare string = p)
//!   xlsx:       sheets: [{name, rows: [[cell]], header?: bool}]  cell = string | number | bool | "=FORMULA"
//!   pptx:       slides: [{title, bullets?: [text], notes?: text}]
//! A paragraph that is mostly Arabic is set right-to-left (docx w:bidi, pptx rtl, html dir=rtl,
//! xlsx sheet right-to-left when its text is mostly Arabic).

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
}

impl Kind {
    pub fn parse(s: &str) -> Result<Kind, String> {
        match s.trim().trim_start_matches('.').to_lowercase().as_str() {
            "docx" | "word" | "doc" => Ok(Kind::Docx),
            "xlsx" | "excel" | "xls" | "sheet" | "spreadsheet" => Ok(Kind::Xlsx),
            "pptx" | "powerpoint" | "ppt" | "slides" | "deck" => Ok(Kind::Pptx),
            "pdf" => Ok(Kind::Pdf),
            other => Err(format!("Unknown document kind \"{other}\" (docx, xlsx, pptx or pdf).")),
        }
    }
    pub fn ext(self) -> &'static str {
        match self {
            Kind::Docx => "docx",
            Kind::Xlsx => "xlsx",
            Kind::Pptx => "pptx",
            Kind::Pdf => "pdf",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Text helpers

/// More Arabic letters than Latin ones.
pub fn mostly_arabic(text: &str) -> bool {
    let (mut ar, mut la) = (0usize, 0usize);
    for c in text.chars() {
        if ('\u{0600}'..='\u{06FF}').contains(&c) || ('\u{0750}'..='\u{077F}').contains(&c) || ('\u{FB50}'..='\u{FDFF}').contains(&c) || ('\u{FE70}'..='\u{FEFF}').contains(&c) {
            ar += 1;
        } else if c.is_alphabetic() {
            la += 1;
        }
    }
    ar > la
}

/// XML text: escaped, and characters XML 1.0 cannot carry dropped.
pub fn xml(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            '\t' | '\n' | '\r' => o.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => o.push(c),
        }
    }
    o
}

/// A cell / text value as a string (numbers as JSON prints them; null as "").
fn text_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a.iter().map(text_of).collect::<Vec<_>>().join(" "),
        Value::Object(_) => v.to_string(),
    }
}

/// A file stem safe on Windows: no reserved characters or names, trimmed, at most 80 characters.
pub fn safe_stem(s: &str) -> String {
    let mut o: String = s
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { ' ' } else { c })
        .collect();
    o = o.split_whitespace().collect::<Vec<_>>().join(" ");
    o = o.trim_matches(|c| c == '.' || c == ' ').to_string();
    let o: String = o.chars().take(80).collect();
    let o = o.trim_end_matches(['.', ' ']).to_string();
    let upper = o.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if o.is_empty() || reserved.contains(&upper.as_str()) {
        "Document".into()
    } else {
        o
    }
}

/// `dir/stem.ext`, or `dir/stem (2).ext`, `(3)` ... — never an existing file.
pub fn unique_path(dir: &Path, stem: &str, ext: &str, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !exists(&first) {
        return first;
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{stem} ({n}).{ext}"));
        if !exists(&p) {
            return p;
        }
    }
    dir.join(format!("{stem} ({}).{ext}", std::process::id()))
}

/// For a path the caller gave: same rule, keeping its folder and stem.
pub fn unique_from(path: &Path, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Document".into());
    let ext = path.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    unique_path(&dir, &stem, &ext, exists)
}

fn now_w3c() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    crate::log::utc(secs)
}

// ---------------------------------------------------------------------------------------------
// Content model

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    H(u8, String),
    P(String),
    Bullet(String),
    Numbered(String),
    Table(Vec<Vec<String>>),
}

pub fn parse_blocks(v: Option<&Value>) -> Result<Vec<Block>, String> {
    let Some(v) = v else { return Ok(vec![]) };
    let arr = v.as_array().ok_or("blocks must be an array.")?;
    let mut out = Vec::new();
    for (i, b) in arr.iter().enumerate() {
        match b {
            Value::String(s) => out.push(Block::P(s.clone())),
            Value::Object(o) => {
                let mut found = false;
                for (k, val) in o {
                    let many = |f: fn(String) -> Block, out: &mut Vec<Block>| match val {
                        Value::Array(items) => items.iter().for_each(|it| out.push(f(text_of(it)))),
                        other => out.push(f(text_of(other))),
                    };
                    match k.as_str() {
                        "h1" | "title" => out.push(Block::H(1, text_of(val))),
                        "h2" => out.push(Block::H(2, text_of(val))),
                        "h3" => out.push(Block::H(3, text_of(val))),
                        "p" | "text" | "paragraph" => out.push(Block::P(text_of(val))),
                        "bullet" | "bullets" => many(Block::Bullet, &mut out),
                        "numbered" | "number" => many(Block::Numbered, &mut out),
                        "table" => {
                            let rows = val.as_array().ok_or(format!("block {i}: table must be an array of rows."))?;
                            let rows: Vec<Vec<String>> = rows
                                .iter()
                                .map(|r| match r {
                                    Value::Array(cells) => cells.iter().map(text_of).collect(),
                                    other => vec![text_of(other)],
                                })
                                .collect();
                            if !rows.is_empty() {
                                out.push(Block::Table(rows));
                            }
                        }
                        _ => continue,
                    }
                    found = true;
                    break;
                }
                if !found {
                    return Err(format!("block {i}: use one of h1, h2, h3, p, bullet, numbered, table."));
                }
            }
            _ => return Err(format!("block {i}: a block is an object like {{\"p\": \"text\"}}.")),
        }
    }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Empty,
    Text(String),
    Num(f64),
    Bool(bool),
    Formula(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<Cell>>,
    pub header: bool,
}

pub fn parse_sheets(v: Option<&Value>) -> Result<Vec<Sheet>, String> {
    let arr = v.and_then(Value::as_array).ok_or("xlsx needs sheets: [{name, rows: [[cell]], header?}].")?;
    let mut out = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for (i, s) in arr.iter().enumerate() {
        let name = s.get("name").map(text_of).unwrap_or_default();
        let mut name: String = name.chars().filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\')).collect::<String>().trim().trim_matches('\'').to_string();
        if name.is_empty() {
            name = format!("Sheet{}", i + 1);
        }
        let mut name: String = name.chars().take(31).collect();
        let base = name.clone();
        let mut n = 2;
        while names.iter().any(|x| x.to_lowercase() == name.to_lowercase()) {
            let suffix = format!(" ({n})");
            name = base.chars().take(31 - suffix.chars().count()).collect::<String>() + &suffix;
            n += 1;
        }
        names.push(name.clone());
        let rows = s.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let rows = rows
            .iter()
            .map(|r| {
                let cells = match r {
                    Value::Array(c) => c.clone(),
                    other => vec![other.clone()],
                };
                cells
                    .iter()
                    .map(|c| match c {
                        Value::Null => Cell::Empty,
                        Value::Bool(b) => Cell::Bool(*b),
                        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(Cell::Num).unwrap_or(Cell::Text(n.to_string())),
                        Value::String(s) if s.starts_with('=') && s.len() > 1 => Cell::Formula(s[1..].to_string()),
                        Value::String(s) if s.is_empty() => Cell::Empty,
                        other => Cell::Text(text_of(other)),
                    })
                    .collect()
            })
            .collect();
        let header = s.get("header").and_then(Value::as_bool).unwrap_or(false);
        out.push(Sheet { name, rows, header });
    }
    if out.is_empty() {
        out.push(Sheet { name: "Sheet1".into(), rows: vec![], header: false });
    }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Slide {
    pub title: String,
    pub bullets: Vec<String>,
    pub notes: String,
}

pub fn parse_slides(v: Option<&Value>) -> Result<Vec<Slide>, String> {
    let arr = v.and_then(Value::as_array).ok_or("pptx needs slides: [{title, bullets?, notes?}].")?;
    let mut out = Vec::new();
    for s in arr {
        let title = s.get("title").map(text_of).unwrap_or_default();
        let bullets = match s.get("bullets") {
            Some(Value::Array(a)) => a.iter().map(text_of).collect(),
            Some(Value::String(t)) => t.lines().map(str::to_string).filter(|l| !l.trim().is_empty()).collect(),
            _ => vec![],
        };
        let notes = s.get("notes").map(text_of).unwrap_or_default();
        out.push(Slide { title, bullets, notes });
    }
    if out.is_empty() {
        return Err("pptx needs at least one slide.".into());
    }
    if out.len() > 200 {
        return Err("At most 200 slides.".into());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Zip

fn zip_parts(parts: &[(String, String)]) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in parts {
            z.start_file(name.as_str(), opts).map_err(|e| e.to_string())?;
            z.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

const XML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

fn rels(items: &[(&str, &str, String)]) -> String {
    let mut s = format!("{XML_HEAD}<Relationships xmlns=\"{PKG_REL_NS}\">");
    for (id, ty, target) in items {
        let ty = if ty.starts_with("http") { ty.to_string() } else { format!("{REL_NS}/{ty}") };
        s += &format!("<Relationship Id=\"{id}\" Type=\"{ty}\" Target=\"{}\"/>", xml(target));
    }
    s + "</Relationships>"
}

fn core_xml(title: &str) -> String {
    let now = now_w3c();
    format!(
        "{XML_HEAD}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:creator>JOYA AI</dc:creator><cp:lastModifiedBy>JOYA AI</cp:lastModifiedBy><dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified></cp:coreProperties>",
        xml(title)
    )
}

fn app_xml() -> String {
    format!("{XML_HEAD}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><Application>JOYA AI</Application></Properties>")
}

const CT_CORE: &str = "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>";

fn root_rels(main: &str) -> String {
    rels(&[
        ("rId1", "officeDocument", main.to_string()),
        ("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml".into()),
        ("rId3", "extended-properties", "docProps/app.xml".into()),
    ])
}

fn content_types(overrides: &str) -> String {
    format!(
        "{XML_HEAD}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>{overrides}{CT_CORE}</Types>"
    )
}

// ---------------------------------------------------------------------------------------------
// DOCX

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn w_runs(text: &str, rtl: bool, bold: bool) -> String {
    let mut rpr = String::new();
    if bold {
        rpr += "<w:b/><w:bCs/>";
    }
    if rtl {
        rpr += "<w:rtl/><w:lang w:bidi=\"ar-EG\"/>";
    }
    let rpr = if rpr.is_empty() { String::new() } else { format!("<w:rPr>{rpr}</w:rPr>") };
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate() {
        out += &format!("<w:r>{rpr}{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", if i > 0 { "<w:br/>" } else { "" }, xml(line.trim_end_matches('\r')));
    }
    out
}

fn w_para(style: Option<&str>, num: Option<u32>, text: &str, bold: bool) -> String {
    let rtl = mostly_arabic(text);
    let mut ppr = String::new();
    if let Some(s) = style {
        ppr += &format!("<w:pStyle w:val=\"{s}\"/>");
    }
    if let Some(n) = num {
        ppr += &format!("<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"{n}\"/></w:numPr>");
    }
    if rtl {
        ppr += "<w:bidi/>";
    }
    let ppr = if ppr.is_empty() { String::new() } else { format!("<w:pPr>{ppr}</w:pPr>") };
    format!("<w:p>{ppr}{}</w:p>", w_runs(text, rtl, bold))
}

fn w_table(rows: &[Vec<String>]) -> String {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let all: String = rows.iter().flatten().cloned().collect::<Vec<_>>().join(" ");
    let rtl = mostly_arabic(&all);
    let width = 9026 / cols as u32; // A4 text width at 1-inch margins, in twentieths of a point
    let mut s = format!(
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/>{}<w:tblW w:w=\"5000\" w:type=\"pct\"/><w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"1\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>",
        if rtl { "<w:bidiVisual/>" } else { "" }
    );
    for _ in 0..cols {
        s += &format!("<w:gridCol w:w=\"{width}\"/>");
    }
    s += "</w:tblGrid>";
    for (ri, row) in rows.iter().enumerate() {
        s += "<w:tr>";
        if ri == 0 && rows.len() > 1 {
            s += "<w:trPr><w:tblHeader/></w:trPr>";
        }
        for ci in 0..cols {
            let text = row.get(ci).map(String::as_str).unwrap_or("");
            s += &format!("<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/></w:tcPr>{}</w:tc>", w_para(None, None, text, ri == 0 && rows.len() > 1));
        }
        s += "</w:tr>";
    }
    s + "</w:tbl>"
}

const DOCX_STYLES: &str = r#"<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-EG"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:cs="Arial"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F4E79"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2E74B5"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>"#;

fn docx_numbering(numbered_groups: u32) -> String {
    let lvl = |fmt: &str, text: &str| {
        format!("<w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr></w:lvl>")
    };
    let mut s = format!("{XML_HEAD}<w:numbering xmlns:w=\"{W_NS}\">");
    s += &format!("<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"singleLevel\"/>{}</w:abstractNum>", lvl("bullet", "•"));
    s += &format!("<w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"singleLevel\"/>{}</w:abstractNum>", lvl("decimal", "%1."));
    s += "<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>";
    // One numbering instance per numbered list, so each list starts at 1.
    for g in 0..numbered_groups {
        s += &format!("<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"1\"/><w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"1\"/></w:lvlOverride></w:num>", g + 2);
    }
    s + "</w:numbering>"
}

pub fn build_docx(title: &str, blocks: &[Block]) -> Result<Vec<u8>, String> {
    let mut body = String::new();
    let mut all_text = String::from(title);
    if !title.trim().is_empty() {
        body += &w_para(Some("Title"), None, title, false);
    }
    let mut groups = 0u32;
    let mut prev_numbered = false;
    let mut last_table = false;
    for b in blocks {
        last_table = false;
        let numbered = matches!(b, Block::Numbered(_));
        match b {
            Block::H(l, t) => body += &w_para(Some(&format!("Heading{l}")), None, t, false),
            Block::P(t) => body += &w_para(None, None, t, false),
            Block::Bullet(t) => body += &w_para(Some("ListParagraph"), Some(1), t, false),
            Block::Numbered(t) => {
                if !prev_numbered {
                    groups += 1;
                }
                body += &w_para(Some("ListParagraph"), Some(groups + 1), t, false);
            }
            Block::Table(rows) => {
                body += &w_table(rows);
                last_table = true;
            }
        }
        match b {
            Block::H(_, t) | Block::P(t) | Block::Bullet(t) | Block::Numbered(t) => {
                all_text.push(' ');
                all_text += t
            }
            Block::Table(r) => r.iter().flatten().for_each(|c| {
                all_text.push(' ');
                all_text += c
            }),
        }
        prev_numbered = numbered;
    }
    if last_table || body.is_empty() {
        body += "<w:p/>";
    }
    let sect_bidi = if mostly_arabic(&all_text) { "<w:bidi/>" } else { "" };
    let doc = format!(
        "{XML_HEAD}<w:document xmlns:w=\"{W_NS}\" xmlns:r=\"{REL_NS}\"><w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/>{sect_bidi}</w:sectPr></w:body></w:document>"
    );
    let ct = content_types(
        "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>",
    );
    zip_parts(&[
        ("[Content_Types].xml".into(), ct),
        ("_rels/.rels".into(), root_rels("word/document.xml")),
        ("word/document.xml".into(), doc),
        ("word/styles.xml".into(), format!("{XML_HEAD}{DOCX_STYLES}")),
        ("word/numbering.xml".into(), docx_numbering(groups)),
        ("word/_rels/document.xml.rels".into(), rels(&[("rId1", "styles", "styles.xml".into()), ("rId2", "numbering", "numbering.xml".into())])),
        ("docProps/core.xml".into(), core_xml(title)),
        ("docProps/app.xml".into(), app_xml()),
    ])
}

// ---------------------------------------------------------------------------------------------
// XLSX

const S_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/// 0 -> "A", 25 -> "Z", 26 -> "AA".
pub fn col_letters(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

fn num_text(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

fn sheet_xml(sh: &Sheet) -> String {
    let all: String = sh.rows.iter().flatten().filter_map(|c| if let Cell::Text(t) = c { Some(t.as_str()) } else { None }).collect::<Vec<_>>().join(" ");
    let rtl = mostly_arabic(&all);
    let cols = sh.rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![8usize; cols];
    for row in &sh.rows {
        for (i, c) in row.iter().enumerate() {
            let n = match c {
                Cell::Text(t) => t.lines().map(|l| l.chars().count()).max().unwrap_or(0),
                Cell::Num(f) => num_text(*f).len(),
                _ => 6,
            };
            widths[i] = widths[i].max(n + 2).min(60);
        }
    }
    let mut s = format!("{XML_HEAD}<worksheet xmlns=\"{S_NS}\" xmlns:r=\"{REL_NS}\"><sheetViews><sheetView {}workbookViewId=\"0\">", if rtl { "rightToLeft=\"1\" " } else { "" });
    if sh.header && sh.rows.len() > 1 {
        s += "<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>";
    }
    s += "</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/>";
    if cols > 0 {
        s += "<cols>";
        for (i, w) in widths.iter().enumerate() {
            s += &format!("<col min=\"{0}\" max=\"{0}\" width=\"{w}\" customWidth=\"1\"/>", i + 1);
        }
        s += "</cols>";
    }
    s += "<sheetData>";
    for (ri, row) in sh.rows.iter().enumerate() {
        let r = ri + 1;
        let style = if sh.header && ri == 0 { " s=\"1\"" } else { "" };
        s += &format!("<row r=\"{r}\">");
        for (ci, c) in row.iter().enumerate() {
            let at = format!("{}{r}", col_letters(ci));
            match c {
                Cell::Empty => {}
                Cell::Text(t) => s += &format!("<c r=\"{at}\" t=\"inlineStr\"{style}><is><t xml:space=\"preserve\">{}</t></is></c>", xml(t)),
                Cell::Num(f) => s += &format!("<c r=\"{at}\"{style}><v>{}</v></c>", num_text(*f)),
                Cell::Bool(b) => s += &format!("<c r=\"{at}\" t=\"b\"{style}><v>{}</v></c>", if *b { 1 } else { 0 }),
                Cell::Formula(f) => s += &format!("<c r=\"{at}\"{style}><f>{}</f></c>", xml(f)),
            }
        }
        s += "</row>";
    }
    s + "</sheetData><pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/></worksheet>"
}

const XLSX_STYLES: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>"#;

pub fn build_xlsx(title: &str, sheets: &[Sheet]) -> Result<Vec<u8>, String> {
    let mut wb = format!("{XML_HEAD}<workbook xmlns=\"{S_NS}\" xmlns:r=\"{REL_NS}\"><bookViews><workbookView/></bookViews><sheets>");
    let mut wb_rels = Vec::new();
    let mut ct = String::from("<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
    let mut parts = Vec::new();
    for (i, sh) in sheets.iter().enumerate() {
        let n = i + 1;
        wb += &format!("<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>", xml(&sh.name));
        wb_rels.push((format!("rId{n}"), "worksheet", format!("worksheets/sheet{n}.xml")));
        ct += &format!("<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
        parts.push((format!("xl/worksheets/sheet{n}.xml"), sheet_xml(sh)));
    }
    wb += "</sheets><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\"/></workbook>";
    let sid = format!("rId{}", sheets.len() + 1);
    wb_rels.push((sid, "styles", "styles.xml".into()));
    let wb_rels: Vec<(&str, &str, String)> = wb_rels.iter().map(|(a, b, c)| (a.as_str(), *b, c.clone())).collect();
    let mut all = vec![
        ("[Content_Types].xml".to_string(), content_types(&ct)),
        ("_rels/.rels".into(), root_rels("xl/workbook.xml")),
        ("xl/workbook.xml".into(), wb),
        ("xl/_rels/workbook.xml.rels".into(), rels(&wb_rels)),
        ("xl/styles.xml".into(), format!("{XML_HEAD}{XLSX_STYLES}")),
        ("docProps/core.xml".into(), core_xml(title)),
        ("docProps/app.xml".into(), app_xml()),
    ];
    all.extend(parts);
    zip_parts(&all)
}

// ---------------------------------------------------------------------------------------------
// PPTX

const P_NS: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const GRP: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";
const CLR_MAP: &str = "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>";

fn defrpr(sz: u32) -> String {
    format!("<a:defRPr sz=\"{sz}\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr>")
}

fn ph_sp(id: u32, name: &str, ph: &str, xfrm: Option<(i64, i64, i64, i64)>, body: &str) -> String {
    let sppr = match xfrm {
        Some((x, y, cx, cy)) => format!("<p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>"),
        None => "<p:spPr/>".into(),
    };
    format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr>{ph}</p:nvPr></p:nvSpPr>{sppr}<p:txBody>{body}</p:txBody></p:sp>")
}

fn a_para(text: &str, bullet: bool) -> String {
    let rtl = mostly_arabic(text);
    let ppr = if rtl { "<a:pPr algn=\"r\" rtl=\"1\"/>" } else { "" };
    let _ = bullet;
    let lang = if rtl { "<a:rPr lang=\"ar-EG\" altLang=\"en-US\" dirty=\"0\"/>" } else { "<a:rPr lang=\"en-US\" dirty=\"0\"/>" };
    let mut runs = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            runs += &format!("<a:br>{lang}</a:br>");
        }
        runs += &format!("<a:r>{lang}<a:t>{}</a:t></a:r>", xml(line.trim_end_matches('\r')));
    }
    format!("<a:p>{ppr}{runs}</a:p>")
}

fn master_xml() -> String {
    let title = ph_sp(2, "Title Placeholder 1", "<p:ph type=\"title\"/>", Some((838200, 365125, 10515600, 1325563)),
        "<a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" rtlCol=\"0\" anchor=\"ctr\"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang=\"en-US\"/><a:t>Click to edit Master title style</a:t></a:r><a:endParaRPr lang=\"en-US\"/></a:p>");
    let body = ph_sp(3, "Text Placeholder 2", "<p:ph type=\"body\" idx=\"1\"/>", Some((838200, 1825625, 10515600, 4351338)),
        "<a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" rtlCol=\"0\"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl=\"0\"/><a:r><a:rPr lang=\"en-US\"/><a:t>Click to edit Master text styles</a:t></a:r></a:p><a:p><a:pPr lvl=\"1\"/><a:r><a:rPr lang=\"en-US\"/><a:t>Second level</a:t></a:r><a:endParaRPr lang=\"en-US\"/></a:p>");
    let lvl = |n: u32, mar: u32, sz: u32| format!("<a:lvl{n}pPr marL=\"{mar}\" indent=\"-228600\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:lnSpc><a:spcPct val=\"90000\"/></a:lnSpc><a:spcBef><a:spcPts val=\"1000\"/></a:spcBef><a:buFont typeface=\"Arial\" panose=\"020B0604020202020204\" pitchFamily=\"34\" charset=\"0\"/><a:buChar char=\"•\"/>{}</a:lvl{n}pPr>", defrpr(sz));
    format!(
        "{XML_HEAD}<p:sldMaster {P_NS}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{GRP}{title}{body}</p:spTree></p:cSld>{CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:lnSpc><a:spcPct val=\"90000\"/></a:lnSpc><a:spcBef><a:spcPct val=\"0\"/></a:spcBef><a:buNone/><a:defRPr sz=\"4000\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mj-lt\"/><a:ea typeface=\"+mj-ea\"/><a:cs typeface=\"+mj-cs\"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>{}{}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr><a:lvl1pPr marL=\"0\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\">{}</a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>",
        lvl(1, 228600, 2400),
        lvl(2, 685800, 2000),
        defrpr(1800)
    )
}

fn layout_xml() -> String {
    let empty = "<a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p>";
    format!(
        "{XML_HEAD}<p:sldLayout {P_NS} type=\"obj\" preserve=\"1\"><p:cSld name=\"Title and Content\"><p:spTree>{GRP}{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
        ph_sp(2, "Title 1", "<p:ph type=\"title\"/>", None, empty),
        ph_sp(3, "Content Placeholder 2", "<p:ph idx=\"1\"/>", None, empty)
    )
}

fn slide_xml(s: &Slide) -> String {
    let mut tree = String::new();
    tree += &ph_sp(2, "Title 1", "<p:ph type=\"title\"/>", None, &format!("<a:bodyPr/><a:lstStyle/>{}", a_para(&s.title, false)));
    if !s.bullets.is_empty() {
        let paras: String = s.bullets.iter().map(|b| a_para(b, true)).collect();
        tree += &ph_sp(3, "Content Placeholder 2", "<p:ph idx=\"1\"/>", None, &format!("<a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>{paras}"));
    }
    format!("{XML_HEAD}<p:sld {P_NS}><p:cSld><p:spTree>{GRP}{tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>")
}

fn notes_master_xml() -> String {
    let img = format!("<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\" idx=\"2\"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"685800\" y=\"1143000\"/><a:ext cx=\"5486400\" cy=\"3086100\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln w=\"12700\"><a:solidFill><a:prstClr val=\"black\"/></a:solidFill></a:ln></p:spPr></p:sp>");
    let body = ph_sp(3, "Notes Placeholder 2", "<p:ph type=\"body\" sz=\"quarter\" idx=\"3\"/>", Some((685800, 4400550, 5486400, 3600450)),
        "<a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" rtlCol=\"0\"/><a:lstStyle/><a:p><a:pPr lvl=\"0\"/><a:r><a:rPr lang=\"en-US\"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>");
    format!(
        "{XML_HEAD}<p:notesMaster {P_NS}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{GRP}{img}{body}</p:spTree></p:cSld>{CLR_MAP}<p:notesStyle><a:lvl1pPr marL=\"0\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\">{}</a:lvl1pPr></p:notesStyle></p:notesMaster>",
        defrpr(1200)
    )
}

fn notes_slide_xml(notes: &str) -> String {
    let img = "<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>";
    let paras: String = notes.split('\n').map(|l| a_para(l, false)).collect();
    let body = ph_sp(3, "Notes Placeholder 2", "<p:ph type=\"body\" idx=\"1\"/>", None, &format!("<a:bodyPr/><a:lstStyle/>{paras}"));
    format!("{XML_HEAD}<p:notes {P_NS}><p:cSld><p:spTree>{GRP}{img}{body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>")
}

fn theme_xml() -> String {
    let font = |typeface: &str| format!("<a:latin typeface=\"{typeface}\" panose=\"020F0502020204030204\"/><a:ea typeface=\"\"/><a:cs typeface=\"Arial\"/><a:font script=\"Arab\" typeface=\"Arial\"/>");
    let grad = |a: &str, b: &str, c: &str| format!("<a:gradFill rotWithShape=\"1\"><a:gsLst><a:gs pos=\"0\"><a:schemeClr val=\"phClr\">{a}</a:schemeClr></a:gs><a:gs pos=\"50000\"><a:schemeClr val=\"phClr\">{b}</a:schemeClr></a:gs><a:gs pos=\"100000\"><a:schemeClr val=\"phClr\">{c}</a:schemeClr></a:gs></a:gsLst><a:lin ang=\"5400000\" scaled=\"0\"/></a:gradFill>");
    let ln = |w: u32| format!("<a:ln w=\"{w}\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln>");
    format!(
        "{XML_HEAD}<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office Theme\"><a:themeElements><a:clrScheme name=\"Office\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"0E2841\"/></a:dk2><a:lt2><a:srgbClr val=\"E8E8E8\"/></a:lt2><a:accent1><a:srgbClr val=\"156082\"/></a:accent1><a:accent2><a:srgbClr val=\"E97132\"/></a:accent2><a:accent3><a:srgbClr val=\"196B24\"/></a:accent3><a:accent4><a:srgbClr val=\"0F9ED5\"/></a:accent4><a:accent5><a:srgbClr val=\"A02B93\"/></a:accent5><a:accent6><a:srgbClr val=\"4EA72E\"/></a:accent6><a:hlink><a:srgbClr val=\"467886\"/></a:hlink><a:folHlink><a:srgbClr val=\"96607D\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Office\"><a:majorFont>{}</a:majorFont><a:minorFont>{}</a:minorFont></a:fontScheme><a:fmtScheme name=\"Office\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>{}{}</a:fillStyleLst><a:lnStyleLst>{}{}{}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad=\"57150\" dist=\"19050\" dir=\"5400000\" algn=\"ctr\" rotWithShape=\"0\"><a:srgbClr val=\"000000\"><a:alpha val=\"63000\"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"><a:tint val=\"95000\"/><a:satMod val=\"170000\"/></a:schemeClr></a:solidFill>{}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>",
        font("Calibri Light"),
        font("Calibri"),
        grad("<a:lumMod val=\"110000\"/><a:satMod val=\"105000\"/><a:tint val=\"67000\"/>", "<a:lumMod val=\"105000\"/><a:satMod val=\"103000\"/><a:tint val=\"73000\"/>", "<a:lumMod val=\"105000\"/><a:satMod val=\"109000\"/><a:tint val=\"81000\"/>"),
        grad("<a:satMod val=\"103000\"/><a:lumMod val=\"102000\"/><a:tint val=\"94000\"/>", "<a:satMod val=\"110000\"/><a:lumMod val=\"100000\"/><a:shade val=\"100000\"/>", "<a:lumMod val=\"99000\"/><a:satMod val=\"120000\"/><a:shade val=\"78000\"/>"),
        ln(12700),
        ln(19050),
        ln(25400),
        grad("<a:tint val=\"93000\"/><a:satMod val=\"150000\"/><a:shade val=\"98000\"/><a:lumMod val=\"102000\"/>", "<a:tint val=\"98000\"/><a:satMod val=\"130000\"/><a:shade val=\"90000\"/><a:lumMod val=\"103000\"/>", "<a:shade val=\"63000\"/><a:satMod val=\"120000\"/>"),
    )
}

pub fn build_pptx(title: &str, slides: &[Slide]) -> Result<Vec<u8>, String> {
    let any_notes = slides.iter().any(|s| !s.notes.trim().is_empty());
    let n = slides.len();
    // presentation.xml.rels: rId1 master, rId2.. slides, then theme, props, notes master.
    let mut prels: Vec<(String, &str, String)> = vec![("rId1".into(), "slideMaster", "slideMasters/slideMaster1.xml".into())];
    let mut sld_ids = String::new();
    for i in 0..n {
        prels.push((format!("rId{}", i + 2), "slide", format!("slides/slide{}.xml", i + 1)));
        sld_ids += &format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 256 + i, i + 2);
    }
    let k = n + 2;
    prels.push((format!("rId{k}"), "theme", "theme/theme1.xml".into()));
    prels.push((format!("rId{}", k + 1), "presProps", "presProps.xml".into()));
    prels.push((format!("rId{}", k + 2), "viewProps", "viewProps.xml".into()));
    prels.push((format!("rId{}", k + 3), "tableStyles", "tableStyles.xml".into()));
    let notes_master_ref = if any_notes {
        prels.push((format!("rId{}", k + 4), "notesMaster", "notesMasters/notesMaster1.xml".into()));
        format!("<p:notesMasterIdLst><p:notesMasterId r:id=\"rId{}\"/></p:notesMasterIdLst>", k + 4)
    } else {
        String::new()
    };
    let pres = format!(
        "{XML_HEAD}<p:presentation {P_NS} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>{notes_master_ref}<p:sldIdLst>{sld_ids}</p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/><p:defaultTextStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr><a:lvl1pPr marL=\"0\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\">{}</a:lvl1pPr></p:defaultTextStyle></p:presentation>",
        defrpr(1800)
    );
    let mut ct = String::from(
        "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/ppt/presProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presProps+xml\"/><Override PartName=\"/ppt/viewProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml\"/><Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/>",
    );
    let prels_ref: Vec<(&str, &str, String)> = prels.iter().map(|(a, b, c)| (a.as_str(), *b, c.clone())).collect();
    let mut parts: Vec<(String, String)> = vec![
        ("_rels/.rels".into(), root_rels("ppt/presentation.xml")),
        ("ppt/presentation.xml".into(), pres),
        ("ppt/_rels/presentation.xml.rels".into(), rels(&prels_ref)),
        ("ppt/slideMasters/slideMaster1.xml".into(), master_xml()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels".into(), rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml".into()), ("rId2", "theme", "../theme/theme1.xml".into())])),
        ("ppt/slideLayouts/slideLayout1.xml".into(), layout_xml()),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(), rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml".into())])),
        ("ppt/theme/theme1.xml".into(), theme_xml()),
        ("ppt/presProps.xml".into(), format!("{XML_HEAD}<p:presentationPr {P_NS}/>")),
        ("ppt/viewProps.xml".into(), format!("{XML_HEAD}<p:viewPr {P_NS}><p:normalViewPr><p:restoredLeft sz=\"15620\"/><p:restoredTop sz=\"94660\"/></p:normalViewPr><p:gridSpacing cx=\"76200\" cy=\"76200\"/></p:viewPr>")),
        ("ppt/tableStyles.xml".into(), format!("{XML_HEAD}<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"{{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}}\"/>")),
        ("docProps/core.xml".into(), core_xml(title)),
        ("docProps/app.xml".into(), app_xml()),
    ];
    if any_notes {
        ct += "<Override PartName=\"/ppt/notesMasters/notesMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml\"/><Override PartName=\"/ppt/theme/theme2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>";
        parts.push(("ppt/notesMasters/notesMaster1.xml".into(), notes_master_xml()));
        parts.push(("ppt/notesMasters/_rels/notesMaster1.xml.rels".into(), rels(&[("rId1", "theme", "../theme/theme2.xml".into())])));
        parts.push(("ppt/theme/theme2.xml".into(), theme_xml()));
    }
    for (i, s) in slides.iter().enumerate() {
        let k = i + 1;
        ct += &format!("<Override PartName=\"/ppt/slides/slide{k}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>");
        parts.push((format!("ppt/slides/slide{k}.xml"), slide_xml(s)));
        let mut srels = vec![("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml".to_string())];
        if !s.notes.trim().is_empty() {
            srels.push(("rId2", "notesSlide", format!("../notesSlides/notesSlide{k}.xml")));
            ct += &format!("<Override PartName=\"/ppt/notesSlides/notesSlide{k}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml\"/>");
            parts.push((format!("ppt/notesSlides/notesSlide{k}.xml"), notes_slide_xml(&s.notes)));
            parts.push((format!("ppt/notesSlides/_rels/notesSlide{k}.xml.rels"), rels(&[("rId1", "notesMaster", "../notesMasters/notesMaster1.xml".into()), ("rId2", "slide", format!("../slides/slide{k}.xml"))])));
        }
        parts.push((format!("ppt/slides/_rels/slide{k}.xml.rels"), rels(&srels)));
    }
    parts.insert(0, ("[Content_Types].xml".into(), content_types(&ct)));
    zip_parts(&parts)
}

// ---------------------------------------------------------------------------------------------
// HTML (for PDF)

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn dir_of(t: &str) -> &'static str {
    if mostly_arabic(t) {
        "rtl"
    } else {
        "ltr"
    }
}

fn html_text(t: &str) -> String {
    html_escape(t).replace('\n', "<br>")
}

pub fn build_html(title: &str, blocks: &[Block]) -> String {
    let all: String = std::iter::once(title.to_string())
        .chain(blocks.iter().map(|b| match b {
            Block::H(_, t) | Block::P(t) | Block::Bullet(t) | Block::Numbered(t) => t.clone(),
            Block::Table(r) => r.iter().flatten().cloned().collect::<Vec<_>>().join(" "),
        }))
        .collect::<Vec<_>>()
        .join(" ");
    let doc_dir = dir_of(&all);
    let lang = if doc_dir == "rtl" { "ar" } else { "en" };
    let mut body = String::new();
    if !title.trim().is_empty() {
        body += &format!("<h1 class=\"title\" dir=\"{}\">{}</h1>\n", dir_of(title), html_text(title));
    }
    let mut open_list: Option<&str> = None;
    for b in blocks {
        let want = match b {
            Block::Bullet(_) => Some("ul"),
            Block::Numbered(_) => Some("ol"),
            _ => None,
        };
        if open_list != want {
            if let Some(l) = open_list {
                body += &format!("</{l}>\n");
            }
            if let Some(l) = want {
                body += &format!("<{l} dir=\"{doc_dir}\">\n");
            }
            open_list = want;
        }
        match b {
            Block::H(l, t) => body += &format!("<h{l} dir=\"{}\">{}</h{l}>\n", dir_of(t), html_text(t)),
            Block::P(t) => body += &format!("<p dir=\"{}\">{}</p>\n", dir_of(t), html_text(t)),
            Block::Bullet(t) | Block::Numbered(t) => body += &format!("<li dir=\"{}\">{}</li>\n", dir_of(t), html_text(t)),
            Block::Table(rows) => {
                let all: String = rows.iter().flatten().cloned().collect::<Vec<_>>().join(" ");
                body += &format!("<table dir=\"{}\">\n", dir_of(&all));
                for (ri, r) in rows.iter().enumerate() {
                    let tag = if ri == 0 && rows.len() > 1 { "th" } else { "td" };
                    body += "<tr>";
                    for c in r {
                        body += &format!("<{tag} dir=\"auto\">{}</{tag}>", html_text(c));
                    }
                    body += "</tr>\n";
                }
                body += "</table>\n";
            }
        }
    }
    if let Some(l) = open_list {
        body += &format!("</{l}>\n");
    }
    format!(
        "<!doctype html>\n<html lang=\"{lang}\" dir=\"{doc_dir}\"><head><meta charset=\"utf-8\"><title>{}</title><style>\n@page {{ size: A4; margin: 20mm 18mm; }}\nbody {{ font-family: \"Segoe UI\", \"Calibri\", \"Arial\", \"Tahoma\", sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }}\nh1, h2, h3 {{ color: #1f4e79; line-height: 1.25; page-break-after: avoid; }}\nh1.title {{ font-size: 24pt; color: #111; margin-top: 0; }}\nh1 {{ font-size: 18pt; }} h2 {{ font-size: 15pt; }} h3 {{ font-size: 12.5pt; color: #222; }}\n[dir=rtl] {{ text-align: right; }}\ntable {{ border-collapse: collapse; width: 100%; margin: 8pt 0; page-break-inside: auto; }}\nth, td {{ border: 1px solid #999; padding: 4pt 6pt; text-align: start; vertical-align: top; }}\nth {{ background: #e7eef7; }}\ntr {{ page-break-inside: avoid; }}\n</style></head><body>\n{body}</body></html>\n",
        html_escape(title)
    )
}

// ---------------------------------------------------------------------------------------------
// One entry point

/// The file bytes for `kind` from the tool's arguments (for pdf: the HTML to print).
pub fn build(kind: Kind, args: &Value) -> Result<Vec<u8>, String> {
    let title = args.get("title").map(text_of).unwrap_or_default();
    match kind {
        Kind::Docx => build_docx(&title, &parse_blocks(args.get("blocks"))?),
        Kind::Pdf => Ok(build_html(&title, &parse_blocks(args.get("blocks"))?).into_bytes()),
        Kind::Xlsx => build_xlsx(&title, &parse_sheets(args.get("sheets"))?),
        Kind::Pptx => build_pptx(&title, &parse_slides(args.get("slides"))?),
    }
}

/// The default file stem: the title, else the first heading / slide title / sheet name, else "Document".
pub fn default_stem(kind: Kind, args: &Value) -> String {
    let title = args.get("title").map(text_of).unwrap_or_default();
    if !title.trim().is_empty() {
        return safe_stem(&title);
    }
    let from = match kind {
        Kind::Docx | Kind::Pdf => parse_blocks(args.get("blocks")).ok().and_then(|b| b.into_iter().find_map(|b| if let Block::H(_, t) = b { Some(t) } else { None })),
        Kind::Pptx => parse_slides(args.get("slides")).ok().and_then(|s| s.into_iter().map(|s| s.title).find(|t| !t.trim().is_empty())),
        Kind::Xlsx => None,
    };
    safe_stem(&from.unwrap_or_else(|| match kind {
        Kind::Xlsx => "Workbook".into(),
        Kind::Pptx => "Presentation".into(),
        _ => "Document".into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;

    fn entries(bytes: &[u8]) -> Vec<(String, String)> {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        (0..z.len())
            .map(|i| {
                let mut f = z.by_index(i).unwrap();
                let mut s = String::new();
                f.read_to_string(&mut s).unwrap();
                (f.name().to_string(), s)
            })
            .collect()
    }

    #[test]
    fn arabic_detection() {
        assert!(mostly_arabic("تقرير المبيعات الشهري"));
        assert!(!mostly_arabic("Monthly sales report"));
        assert!(mostly_arabic("تقرير Q3 المبيعات"));
        assert!(!mostly_arabic("12345"));
    }

    #[test]
    fn names() {
        assert_eq!(safe_stem("Q3: sales/report?"), "Q3 sales report");
        assert_eq!(safe_stem("  ..CON.. "), "Document");
        assert_eq!(safe_stem(""), "Document");
        let taken = |p: &Path| p.ends_with("Report.docx") || p.ends_with("Report (2).docx");
        assert_eq!(unique_path(Path::new("/d"), "Report", "docx", &taken), PathBuf::from("/d/Report (3).docx"));
        assert_eq!(unique_path(Path::new("/d"), "New", "docx", &taken), PathBuf::from("/d/New.docx"));
        assert_eq!(unique_from(Path::new("/d/Report.docx"), &taken), PathBuf::from("/d/Report (3).docx"));
        assert_eq!(col_letters(0), "A");
        assert_eq!(col_letters(25), "Z");
        assert_eq!(col_letters(26), "AA");
        assert_eq!(col_letters(701), "ZZ");
        assert_eq!(col_letters(702), "AAA");
        assert_eq!(Kind::parse("Word").unwrap(), Kind::Docx);
        assert!(Kind::parse("odt").is_err());
    }

    #[test]
    fn blocks_parse() {
        let b = parse_blocks(Some(&json!([{"h1": "A"}, "plain", {"bullet": ["x", "y"]}, {"numbered": "n"}, {"table": [["a", 1], ["b", 2.5]]}]))).unwrap();
        assert_eq!(b.len(), 6);
        assert_eq!(b[1], Block::P("plain".into()));
        assert_eq!(b[5], Block::Table(vec![vec!["a".into(), "1".into()], vec!["b".into(), "2.5".into()]]));
        assert!(parse_blocks(Some(&json!([{"zz": 1}]))).is_err());
        assert!(parse_blocks(Some(&json!([5]))).is_err());
    }

    #[test]
    fn docx_parts() {
        let blocks = parse_blocks(Some(&json!([{"h1": "Intro & <scope>"}, {"p": "تقرير المبيعات"}, {"numbered": "one"}, {"numbered": "two"}, {"p": "x"}, {"numbered": "again"}, {"table": [["h"]]}]))).unwrap();
        let z = entries(&build_docx("T", &blocks).unwrap());
        let doc = &z.iter().find(|(n, _)| n == "word/document.xml").unwrap().1;
        assert!(doc.contains("Intro &amp; &lt;scope&gt;"));
        assert!(doc.contains("<w:bidi/></w:pPr><w:r><w:rPr><w:rtl/>"));
        assert!(doc.contains("<w:numId w:val=\"2\"/>") && doc.contains("<w:numId w:val=\"3\"/>"));
        assert!(doc.ends_with("</w:tbl><w:p/><w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>"));
        let num = &z.iter().find(|(n, _)| n == "word/numbering.xml").unwrap().1;
        assert!(num.contains("w:numId=\"3\""));
        assert!(z.iter().any(|(n, _)| n == "[Content_Types].xml"));
    }

    #[test]
    fn xlsx_parts() {
        let sheets = parse_sheets(Some(&json!([{"name": "Sales: Q3", "header": true, "rows": [["Item", "Qty"], ["a", 2], ["b", 3.5], ["Total", "=SUM(B2:B3)"]]}, {"name": "Sales Q3", "rows": [[true, null, "نص"]]}]))).unwrap();
        assert_eq!(sheets[0].name, "Sales Q3");
        assert_eq!(sheets[1].name, "Sales Q3 (2)");
        assert_eq!(sheets[0].rows[3][1], Cell::Formula("SUM(B2:B3)".into()));
        let z = entries(&build_xlsx("T", &sheets).unwrap());
        let s1 = &z.iter().find(|(n, _)| n == "xl/worksheets/sheet1.xml").unwrap().1;
        assert!(s1.contains("<c r=\"B4\"><f>SUM(B2:B3)</f></c>"));
        assert!(s1.contains("<c r=\"B3\"><v>3.5</v></c>"));
        assert!(s1.contains("state=\"frozen\""));
        assert!(s1.contains("<c r=\"A1\" t=\"inlineStr\" s=\"1\">"));
        let s2 = &z.iter().find(|(n, _)| n == "xl/worksheets/sheet2.xml").unwrap().1;
        assert!(s2.contains("rightToLeft=\"1\""));
        assert!(s2.contains("<c r=\"A1\" t=\"b\"><v>1</v></c>"));
    }

    #[test]
    fn pptx_parts() {
        let slides = parse_slides(Some(&json!([{"title": "Hello", "bullets": ["a", "b"]}, {"title": "مرحبا", "bullets": ["أهلا"], "notes": "say hi"}]))).unwrap();
        let z = entries(&build_pptx("Deck", &slides).unwrap());
        let names: Vec<&str> = z.iter().map(|(n, _)| n.as_str()).collect();
        for need in ["ppt/presentation.xml", "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/notesSlides/notesSlide2.xml", "ppt/notesMasters/notesMaster1.xml", "ppt/theme/theme2.xml"] {
            assert!(names.contains(&need), "{need}");
        }
        assert!(!names.contains(&"ppt/notesSlides/notesSlide1.xml"));
        let s2 = &z.iter().find(|(n, _)| n == "ppt/slides/slide2.xml").unwrap().1;
        assert!(s2.contains("rtl=\"1\""));
        assert!(parse_slides(Some(&json!([]))).is_err());
    }

    #[test]
    fn html() {
        let blocks = parse_blocks(Some(&json!([{"h2": "قسم"}, {"bullet": ["a", "b"]}, {"p": "<b>x</b>"}, {"table": [["h1", "h2"], ["1", "2"]]}]))).unwrap();
        let h = build_html("عنوان", &blocks);
        assert!(h.contains("<html lang=\"ar\" dir=\"rtl\">"));
        assert!(h.contains("<ul dir=\"rtl\">\n<li dir=\"ltr\">a</li>"));
        assert!(h.contains("&lt;b&gt;x&lt;/b&gt;"));
        assert!(h.contains("<th dir=\"auto\">h1</th>"));
        assert_eq!(default_stem(Kind::Pdf, &json!({"blocks": [{"p": "x"}, {"h1": "Plan"}]})), "Plan");
        assert_eq!(default_stem(Kind::Xlsx, &json!({})), "Workbook");
    }

    /// Writes sample files for checking with python-docx / openpyxl / python-pptx:
    /// JOYA_DOCS_OUT=/some/dir cargo test write_samples -- --ignored
    #[test]
    #[ignore]
    fn write_samples() {
        let out = std::env::var("JOYA_DOCS_OUT").unwrap_or_else(|_| "/tmp/joya-docs".into());
        std::fs::create_dir_all(&out).unwrap();
        let blocks = json!([{"h1": "Overview"}, {"p": "This report covers Q3.\nSecond line."}, {"h2": "ملخص"}, {"p": "هذا تقرير المبيعات للربع الثالث."},
            {"bullet": ["First point", "النقطة الثانية"]}, {"numbered": ["Step one", "Step two"]}, {"p": "between"}, {"numbered": ["Again one"]},
            {"h3": "Table"}, {"table": [["Item", "Qty", "ملاحظة"], ["Basil", 12, "جيد"], ["Thyme", 3.5]]}]);
        let a = json!({"title": "Q3 Report — تقرير", "blocks": blocks});
        std::fs::write(format!("{out}/sample.docx"), build(Kind::Docx, &a).unwrap()).unwrap();
        std::fs::write(format!("{out}/sample.html"), build(Kind::Pdf, &a).unwrap()).unwrap();
        let x = json!({"title": "Sales", "sheets": [{"name": "Q3", "header": true, "rows": [["Item", "Qty", "Price", "Total"], ["Basil", 12, 2.5, "=B2*C2"], ["Thyme", 3, 4, "=B3*C3"], ["Sum", null, null, "=SUM(D2:D3)"]]}, {"name": "عربي", "rows": [["الصنف", "الكمية"], ["ريحان", 5]]}]});
        std::fs::write(format!("{out}/sample.xlsx"), build(Kind::Xlsx, &x).unwrap()).unwrap();
        let p = json!({"title": "Deck", "slides": [{"title": "Welcome", "bullets": ["One", "Two\nwith a line break"], "notes": "Speaker notes here"}, {"title": "مرحبا", "bullets": ["النقطة الأولى", "الثانية"]}, {"title": "Title only"}]});
        std::fs::write(format!("{out}/sample.pptx"), build(Kind::Pptx, &p).unwrap()).unwrap();
        let p2 = json!({"slides": [{"title": "No notes", "bullets": ["x"]}]});
        std::fs::write(format!("{out}/sample_nonotes.pptx"), build(Kind::Pptx, &p2).unwrap()).unwrap();
    }
}
