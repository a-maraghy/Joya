//! PDFs as files (pure; unit-tested in core-tests): read the text of some or all pages, merge
//! several into one. With lopdf, all in this app: no PDF reader is started, nothing in a PDF is
//! run (scripts, forms and links are only ever bytes here). Password-protected PDFs are refused.
//! Making a PDF from a Word / Excel / PowerPoint file needs Office (office_com.rs).

use lopdf::{Document, Object, ObjectId};
use std::collections::BTreeMap;

pub const MAX_PDF: usize = 200 * 1024 * 1024;
pub const MAX_MERGE: usize = 50;

fn load(bytes: &[u8], what: &str) -> Result<Document, String> {
    if bytes.len() > MAX_PDF {
        return Err(format!("{what} is larger than 200 MB."));
    }
    if !bytes.starts_with(b"%PDF") && !bytes[..bytes.len().min(1024)].windows(4).any(|w| w == b"%PDF") {
        return Err(format!("{what} is not a PDF."));
    }
    let doc = Document::load_mem(bytes).map_err(|e| format!("{what} could not be read as a PDF ({e})."))?;
    if doc.is_encrypted() {
        return Err(format!("{what} is password-protected: JOYA AI does not open protected PDFs."));
    }
    Ok(doc)
}

/// "1-3,5" -> [1, 2, 3, 5] within 1..=count. Empty / "all" -> every page.
pub fn page_list(spec: Option<&str>, count: u32) -> Result<Vec<u32>, String> {
    let s = spec.unwrap_or("").trim();
    if s.is_empty() || s.eq_ignore_ascii_case("all") {
        return Ok((1..=count).collect());
    }
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (a, b) = part.split_once('-').unwrap_or((part, part));
        let a: u32 = a.trim().parse().map_err(|_| format!("pages is like \"1-3,5\" (got \"{part}\")."))?;
        let b: u32 = if b.trim().is_empty() { count } else { b.trim().parse().map_err(|_| format!("pages is like \"1-3,5\" (got \"{part}\")."))? };
        if a == 0 || a > b || b > count {
            return Err(format!("Pages {part}: the PDF has {count} page(s)."));
        }
        for p in a..=b {
            if !out.contains(&p) {
                out.push(p);
            }
        }
        if out.len() > 2000 {
            return Err("At most 2000 pages at once.".into());
        }
    }
    Ok(out)
}

/// The text of the pages, each under "[page N]", cut at `max_chars`.
pub fn read_text(bytes: &[u8], pages: Option<&str>, max_chars: usize) -> Result<String, String> {
    let doc = load(bytes, "The file")?;
    let count = doc.get_pages().len() as u32;
    let list = page_list(pages, count)?;
    let mut out = format!("{count} page(s).\n");
    for p in list {
        let t = doc.extract_text(&[p]).unwrap_or_default();
        let t = t.trim();
        let block = format!("\n[page {p}]\n{}\n", if t.is_empty() { "(no text: a scanned page or images only)" } else { t });
        if out.len() + block.len() > max_chars {
            out += &format!("… (cut at {max_chars} characters: read fewer pages, e.g. pages \"{p}-{}\")\n", (p + 9).min(count));
            break;
        }
        out += &block;
    }
    Ok(out)
}

pub fn page_count(bytes: &[u8]) -> Result<u32, String> {
    Ok(load(bytes, "The file")?.get_pages().len() as u32)
}

/// One PDF from several, in order (lopdf's documented merge: renumber each, collect the pages under
/// one page tree, keep the first catalog).
pub fn merge(inputs: &[(String, Vec<u8>)]) -> Result<(Vec<u8>, u32), String> {
    if inputs.len() < 2 {
        return Err("Give at least two PDFs to merge.".into());
    }
    if inputs.len() > MAX_MERGE {
        return Err(format!("At most {MAX_MERGE} PDFs at once."));
    }
    let mut max_id = 1;
    let mut pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut doc = Document::with_version("1.5");
    for (name, bytes) in inputs {
        let mut d = load(bytes, name)?;
        d.renumber_objects_with(max_id);
        max_id = d.max_id + 1;
        for (_, id) in d.get_pages() {
            let mut page = d.get_dictionary(id).map_err(|e| format!("{name}: {e}"))?.clone();
            // What a page inherits from its page tree (the tree itself is replaced) goes on the page.
            for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
                if page.has(key) {
                    continue;
                }
                let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
                let mut hops = 0;
                while let Some(pid) = parent {
                    hops += 1;
                    let Ok(pd) = d.get_dictionary(pid) else { break };
                    if let Ok(v) = pd.get(key) {
                        page.set(key.to_vec(), v.clone());
                        break;
                    }
                    parent = pd.get(b"Parent").and_then(Object::as_reference).ok();
                    if hops > 64 {
                        break;
                    }
                }
            }
            pages.insert(id, Object::Dictionary(page));
        }
        objects.extend(d.objects);
    }
    let mut catalog: Option<(ObjectId, Object)> = None;
    let mut tree: Option<(ObjectId, Object)> = None;
    for (id, o) in objects {
        match o.type_name().unwrap_or(b"") {
            b"Catalog" => {
                if catalog.is_none() {
                    catalog = Some((id, o));
                }
            }
            b"Pages" => {
                if let Ok(dict) = o.as_dict() {
                    let mut dict = dict.clone();
                    if let Some((_, ref old)) = tree {
                        if let Ok(od) = old.as_dict() {
                            dict.extend(od);
                        }
                    }
                    tree = Some((tree.as_ref().map(|t| t.0).unwrap_or(id), Object::Dictionary(dict)));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {} // pages go in below; outlines are dropped
            _ => {
                doc.objects.insert(id, o);
            }
        }
    }
    let (tree_id, tree_obj) = tree.ok_or("No page tree in these PDFs.")?;
    let (cat_id, cat_obj) = catalog.ok_or("No catalog in these PDFs.")?;
    for (id, o) in &pages {
        if let Ok(dict) = o.as_dict() {
            let mut dict = dict.clone();
            dict.set("Parent", tree_id);
            doc.objects.insert(*id, Object::Dictionary(dict));
        }
    }
    if let Ok(dict) = tree_obj.as_dict() {
        let mut dict = dict.clone();
        dict.set("Count", pages.len() as u32);
        dict.set("Kids", pages.keys().map(|id| Object::Reference(*id)).collect::<Vec<_>>());
        doc.objects.insert(tree_id, Object::Dictionary(dict));
    }
    if let Ok(dict) = cat_obj.as_dict() {
        let mut dict = dict.clone();
        dict.set("Pages", tree_id);
        dict.remove(b"Outlines");
        // Never carry a document-open action or scripts across.
        dict.remove(b"OpenAction");
        dict.remove(b"AA");
        dict.remove(b"Names");
        doc.objects.insert(cat_id, Object::Dictionary(dict));
    }
    doc.trailer.set("Root", cat_id);
    doc.max_id = doc.objects.len() as u32;
    doc.renumber_objects();
    doc.adjust_zero_pages();
    doc.compress();
    let n = doc.get_pages().len() as u32;
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("Could not write the merged PDF: {e}"))?;
    Ok((out, n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Stream};

    /// A small PDF with `pages` pages, each saying "<label> page N".
    pub fn sample(label: &str, pages: u32) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });
        let mut kids = Vec::new();
        for n in 1..=pages {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 24.into()]),
                    Operation::new("Td", vec![100.into(), 600.into()]),
                    Operation::new("Tj", vec![Object::string_literal(format!("{label} page {n}"))]),
                    Operation::new("ET", vec![]),
                ],
            };
            let cid = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let pid = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => cid });
            kids.push(Object::Reference(pid));
        }
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => pages as i64, "Resources" => resources_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()] }));
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "OpenAction" => dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("app.alert(1)") } });
        doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn pages_spec() {
        assert_eq!(page_list(None, 3).unwrap(), vec![1, 2, 3]);
        assert_eq!(page_list(Some("all"), 2).unwrap(), vec![1, 2]);
        assert_eq!(page_list(Some("2-3, 1, 2"), 5).unwrap(), vec![2, 3, 1]);
        assert_eq!(page_list(Some("4-"), 5).unwrap(), vec![4, 5]);
        assert!(page_list(Some("0"), 5).is_err());
        assert!(page_list(Some("3-9"), 5).is_err());
        assert!(page_list(Some("x"), 5).is_err());
    }

    #[test]
    fn read_and_merge() {
        let a = sample("Alpha", 2);
        let b = sample("Beta", 3);
        let t = read_text(&a, None, 10_000).unwrap();
        assert!(t.starts_with("2 page(s).") && t.contains("[page 1]") && t.contains("Alpha page 2"), "{t}");
        let t1 = read_text(&b, Some("3"), 10_000).unwrap();
        assert!(t1.contains("Beta page 3") && !t1.contains("Beta page 1"), "{t1}");
        let (m, n) = merge(&[("a.pdf".into(), a.clone()), ("b.pdf".into(), b)]).unwrap();
        assert_eq!(n, 5);
        let t = read_text(&m, None, 10_000).unwrap();
        assert!(t.contains("Alpha page 1") && t.contains("Beta page 3"), "{t}");
        assert!(t.find("Alpha page 2").unwrap() < t.find("Beta page 1").unwrap(), "in order");
        let raw = String::from_utf8_lossy(&m).to_string();
        assert!(!raw.contains("JavaScript") && !raw.contains("OpenAction"), "no open action carried over");
        assert!(merge(&[("a.pdf".into(), a.clone())]).is_err());
        assert!(merge(&[("a.pdf".into(), a), ("x.pdf".into(), b"not a pdf".to_vec())]).unwrap_err().contains("x.pdf"));
        assert!(read_text(b"hello", None, 100).is_err());
    }
}
