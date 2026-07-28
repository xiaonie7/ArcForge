use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const APP_HOME_ENV: &str = "ARCFORGE_HOME";
const LEGACY_APP_HOME_ENV: &str = "LIVEAGENT_HOME";
const APP_HOME_DIR: &str = ".arcforge";
const LEGACY_APP_HOME_DIR: &str = ".liveagent";

pub fn app_storage_dir() -> Result<PathBuf, String> {
    if let Some(path) = configured_home(APP_HOME_ENV) {
        return ensure_directory(path);
    }

    // Keep explicit legacy deployments working until operators move the
    // override to ARCFORGE_HOME.
    if let Some(path) = configured_home(LEGACY_APP_HOME_ENV) {
        return ensure_directory(path);
    }

    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    let current = home.join(APP_HOME_DIR);
    let legacy = home.join(LEGACY_APP_HOME_DIR);
    migrate_legacy_home(&legacy, &current)?;
    ensure_directory(current)
}

fn configured_home(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn ensure_directory(path: PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Failed to create application directory {}: {error}",
            path.display()
        )
    })?;
    Ok(path)
}

fn migrate_legacy_home(legacy: &Path, current: &Path) -> Result<(), String> {
    if current.exists() || !legacy.is_dir() {
        return Ok(());
    }

    match fs::rename(legacy, current) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_directory(legacy, current).map_err(|copy_error| {
                format!(
                    "Failed to migrate legacy application data from {} to {}: rename failed ({rename_error}); copy failed ({copy_error})",
                    legacy.display(),
                    current.display()
                )
            })
        }
    }
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_home_to_arcforge_home() {
        let temp = tempfile::tempdir().expect("tempdir");
        let legacy = temp.path().join(LEGACY_APP_HOME_DIR);
        let current = temp.path().join(APP_HOME_DIR);
        fs::create_dir_all(legacy.join("skills")).expect("legacy dir");
        fs::write(legacy.join("skills").join("demo.txt"), "legacy").expect("legacy file");

        migrate_legacy_home(&legacy, &current).expect("migration");

        assert_eq!(
            fs::read_to_string(current.join("skills").join("demo.txt")).expect("migrated file"),
            "legacy"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn leaves_existing_arcforge_home_untouched() {
        let temp = tempfile::tempdir().expect("tempdir");
        let legacy = temp.path().join(LEGACY_APP_HOME_DIR);
        let current = temp.path().join(APP_HOME_DIR);
        fs::create_dir_all(&legacy).expect("legacy dir");
        fs::create_dir_all(&current).expect("current dir");
        fs::write(legacy.join("settings.db"), "legacy").expect("legacy file");
        fs::write(current.join("settings.db"), "current").expect("current file");

        migrate_legacy_home(&legacy, &current).expect("migration");

        assert_eq!(
            fs::read_to_string(current.join("settings.db")).expect("current file"),
            "current"
        );
        assert!(legacy.exists());
    }
}
