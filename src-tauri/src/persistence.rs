use crate::models::CommandResult;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::GetLastError;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(1);

fn sync_file(path: &Path) -> CommandResult<()> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_existing_file(destination: &Path, temporary: &Path, backup: &Path) -> CommandResult<()> {
    if backup.exists() {
        fs::remove_file(backup).map_err(|error| error.to_string())?;
    }

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination_wide = wide(destination);
    let temporary_wide = wide(temporary);
    let backup_wide = wide(backup);
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        return Err(format!(
            "could not atomically replace '{}': Windows error {}",
            destination.display(),
            unsafe { GetLastError() }
        ));
    }

    Ok(())
}

#[cfg(not(windows))]
fn replace_existing_file(destination: &Path, temporary: &Path, backup: &Path) -> CommandResult<()> {
    fs::copy(destination, backup).map_err(|error| error.to_string())?;
    sync_file(backup)?;
    fs::rename(temporary, destination).map_err(|error| error.to_string())
}

pub(crate) fn durable_replace(
    destination: &Path,
    backup: &Path,
    payload: &[u8],
) -> CommandResult<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| String::from("persistent file path has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let temporary = destination.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(payload).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);

        if destination.exists() {
            replace_existing_file(destination, &temporary, backup)?;
        } else {
            fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
            sync_file(destination)?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
