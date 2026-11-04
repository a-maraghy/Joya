//! The machine token, in Windows Credential Manager only (a generic credential, this computer):
//! never in a file, the settings, the log or the repo. Target: "JOYA AI machine token (<host>)".

pub fn target(host: &str) -> String {
    format!("JOYA AI machine token ({})", host)
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let mut t: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let mut user: Vec<u16> = "JOYA AI".encode_utf16().chain(Some(0)).collect();
        let mut blob = secret.as_bytes().to_vec();
        let c = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(t.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        let r = unsafe { CredWriteW(&c, 0) };
        blob.iter_mut().for_each(|b| *b = 0);
        r.map_err(|e| e.message())
    }

    pub fn read(target: &str) -> Option<String> {
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            CredReadW(&HSTRING::from(target), CRED_TYPE_GENERIC, None, &mut p).ok()?;
            if p.is_null() {
                return None;
            }
            let c = &*p;
            let bytes = if c.CredentialBlob.is_null() { Vec::new() } else { std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec() };
            CredFree(p as *const core::ffi::c_void);
            String::from_utf8(bytes).ok().filter(|s| !s.is_empty())
        }
    }

    pub fn delete(target: &str) {
        unsafe {
            let _ = CredDeleteW(&HSTRING::from(target), CRED_TYPE_GENERIC, None);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    // Not Windows (the build box's checks): no store, so never linked.
    pub fn write(_t: &str, _s: &str) -> Result<(), String> {
        Err("Credential Manager is Windows only".into())
    }
    pub fn read(_t: &str) -> Option<String> {
        None
    }
    pub fn delete(_t: &str) {}
}

pub fn write(host: &str, token: &str) -> Result<(), String> {
    imp::write(&target(host), token)
}
pub fn read(host: &str) -> Option<String> {
    imp::read(&target(host))
}
pub fn delete(host: &str) {
    imp::delete(&target(host))
}
