use std::{
    collections::HashSet,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use futures_util::TryStreamExt;
use keyring::{Entry as KeyringEntry, Error as KeyringError};
use rusqlite::{
    params, params_from_iter,
    types::{Value as SqliteValue, ValueRef as SqliteValueRef},
    Connection as SqliteConnection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number as JsonNumber, Value as JsonValue};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlConnection, MySqlRow, MySqlSslMode},
    postgres::{PgConnectOptions, PgConnection, PgRow, PgSslMode},
    Column, Connection as _, MySql, Postgres, Row, TypeInfo, ValueRef as _,
};
use uuid::Uuid;

const KEYRING_SERVICE: &str = "ArcForge.Database";
const DEFAULT_QUERY_TIMEOUT_MS: u64 = 15_000;
const MIN_QUERY_TIMEOUT_MS: u64 = 1_000;
const MAX_QUERY_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_ROWS: usize = 200;
const HARD_MAX_ROWS: usize = 1_000;
const DEFAULT_MAX_AFFECTED_ROWS: u64 = 100;
const HARD_MAX_AFFECTED_ROWS: u64 = 1_000;
const MAX_QUERY_BYTES: usize = 256 * 1024;
const MAX_PARAM_COUNT: usize = 256;
const MAX_PARAM_BYTES: usize = 1024 * 1024;
const MAX_CELL_BYTES: usize = 64 * 1024;
const MAX_RESULT_BYTES: usize = 1024 * 1024;
const RESULT_ENVELOPE_RESERVE_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DatabaseErrorCode {
    #[serde(rename = "DB_INVALID_INPUT")]
    InvalidInput,
    #[serde(rename = "DB_PROFILE_NOT_FOUND")]
    ProfileNotFound,
    #[serde(rename = "DB_PROFILE_DISABLED")]
    ProfileDisabled,
    #[serde(rename = "DB_PASSWORD_REQUIRED")]
    PasswordRequired,
    #[serde(rename = "DB_CREDENTIAL_STORE")]
    CredentialStore,
    #[serde(rename = "DB_CONNECTION_FAILED")]
    ConnectionFailed,
    #[serde(rename = "DB_QUERY_REJECTED")]
    QueryRejected,
    #[serde(rename = "DB_WRITE_DISABLED")]
    WriteDisabled,
    #[serde(rename = "DB_WRITE_NOT_AUTHORIZED")]
    WriteNotAuthorized,
    #[serde(rename = "DB_TIMEOUT")]
    Timeout,
    #[serde(rename = "DB_LIMIT_EXCEEDED")]
    LimitExceeded,
    #[serde(rename = "DB_DATABASE_ERROR")]
    DatabaseError,
    #[serde(rename = "DB_STORAGE_ERROR")]
    StorageError,
    #[serde(rename = "DB_INTERNAL")]
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCommandError {
    pub code: DatabaseErrorCode,
    pub message: String,
}

impl DatabaseCommandError {
    fn new(code: DatabaseErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(DatabaseErrorCode::InvalidInput, message)
    }

    fn database() -> Self {
        Self::new(
            DatabaseErrorCode::DatabaseError,
            "The database operation failed.",
        )
    }

    fn connection() -> Self {
        Self::new(
            DatabaseErrorCode::ConnectionFailed,
            "Could not connect to the database.",
        )
    }

    fn timeout() -> Self {
        Self::new(
            DatabaseErrorCode::Timeout,
            "The database operation timed out.",
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseDriver {
    Sqlite,
    Postgresql,
    Mysql,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProfile {
    pub id: String,
    pub name: String,
    pub driver: DatabaseDriver,
    pub host: String,
    pub port: u16,
    pub database_name: String,
    pub username: String,
    pub ssl_mode: String,
    pub sqlite_path: String,
    pub enabled: bool,
    pub allow_writes: bool,
    pub query_timeout_ms: u64,
    pub max_rows: usize,
    pub max_affected_rows: u64,
    pub password_configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProfileInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub driver: DatabaseDriver,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub database_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_ssl_mode")]
    pub ssl_mode: String,
    #[serde(default)]
    pub sqlite_path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub allow_writes: bool,
    #[serde(default = "default_query_timeout_ms")]
    pub query_timeout_ms: u64,
    #[serde(default = "default_max_rows")]
    pub max_rows: usize,
    #[serde(default = "default_max_affected_rows")]
    pub max_affected_rows: u64,
}

#[derive(Clone, Default)]
enum PasswordUpdate {
    #[default]
    Unchanged,
    Clear,
    Set(String),
}

fn deserialize_password_update<'de, D>(deserializer: D) -> Result<PasswordUpdate, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<String>::deserialize(deserializer)? {
        Some(value) => PasswordUpdate::Set(value),
        None => PasswordUpdate::Clear,
    })
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProfileSaveInput {
    pub profile: DatabaseProfileInput,
    #[serde(default, deserialize_with = "deserialize_password_update")]
    password_update: PasswordUpdate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnectionTestResult {
    pub ok: bool,
    pub elapsed_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DatabaseParam {
    Null,
    Boolean { value: bool },
    Integer { value: DatabaseIntegerParam },
    Float { value: f64 },
    Text { value: String },
    BytesBase64 { value: String },
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum DatabaseIntegerParam {
    String(String),
    Number(i64),
}

#[derive(Clone)]
enum BoundParam {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseQueryAction {
    Query,
    ListTables,
    DescribeTable,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryInput {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub connection: Option<DatabaseConnectionInput>,
    pub action: DatabaseQueryAction,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub params: Vec<DatabaseParam>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub max_rows: Option<usize>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExecuteInput {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub connection: Option<DatabaseConnectionInput>,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<DatabaseParam>,
    #[serde(default)]
    pub max_affected_rows: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnectionInput {
    pub driver: DatabaseDriver,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub database_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_ssl_mode")]
    pub ssl_mode: String,
    #[serde(default)]
    pub sqlite_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseColumn {
    pub name: String,
    #[serde(rename = "dataType")]
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCell {
    #[serde(rename = "type")]
    pub cell_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
    #[serde(skip_serializing_if = "is_false")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryResult {
    pub profile_id: String,
    pub columns: Vec<DatabaseColumn>,
    pub rows: Vec<Vec<DatabaseCell>>,
    pub row_count: usize,
    pub truncated: bool,
    #[serde(rename = "durationMs")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExecuteResult {
    pub profile_id: String,
    pub affected_rows: u64,
    #[serde(rename = "durationMs")]
    pub elapsed_ms: u64,
}

fn default_true() -> bool {
    true
}

fn default_ssl_mode() -> String {
    "prefer".to_string()
}

fn default_query_timeout_ms() -> u64 {
    DEFAULT_QUERY_TIMEOUT_MS
}

fn default_max_rows() -> usize {
    DEFAULT_MAX_ROWS
}

fn default_max_affected_rows() -> u64 {
    DEFAULT_MAX_AFFECTED_ROWS
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn duration_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn keyring_entry(profile_id: &str) -> Result<KeyringEntry, DatabaseCommandError> {
    KeyringEntry::new(KEYRING_SERVICE, profile_id).map_err(|_| {
        DatabaseCommandError::new(
            DatabaseErrorCode::CredentialStore,
            "The system credential store is unavailable.",
        )
    })
}

fn read_password(profile_id: &str) -> Result<Option<String>, DatabaseCommandError> {
    match keyring_entry(profile_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err(DatabaseCommandError::new(
            DatabaseErrorCode::CredentialStore,
            "Could not read the database credential.",
        )),
    }
}

fn set_password(profile_id: &str, password: &str) -> Result<(), DatabaseCommandError> {
    keyring_entry(profile_id)?
        .set_password(password)
        .map_err(|_| {
            DatabaseCommandError::new(
                DatabaseErrorCode::CredentialStore,
                "Could not save the database credential.",
            )
        })
}

fn clear_password(profile_id: &str) -> Result<(), DatabaseCommandError> {
    match keyring_entry(profile_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(DatabaseCommandError::new(
            DatabaseErrorCode::CredentialStore,
            "Could not remove the database credential.",
        )),
    }
}

fn restore_password(profile_id: &str, password: Option<&str>) {
    match password {
        Some(value) => {
            let _ = set_password(profile_id, value);
        }
        None => {
            let _ = clear_password(profile_id);
        }
    }
}

fn open_profiles_db() -> Result<SqliteConnection, DatabaseCommandError> {
    crate::commands::settings::open_db().map_err(|_| {
        DatabaseCommandError::new(
            DatabaseErrorCode::StorageError,
            "Could not open the database profile store.",
        )
    })
}

fn validate_profile_id(value: &str) -> Result<(), DatabaseCommandError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(DatabaseCommandError::invalid("The profile id is invalid."));
    }
    Ok(())
}

fn normalize_profile(
    mut input: DatabaseProfileInput,
) -> Result<DatabaseProfileInput, DatabaseCommandError> {
    input.id = input.id.trim().to_string();
    if input.id.is_empty() {
        input.id = Uuid::new_v4().to_string();
    }
    validate_profile_id(&input.id)?;
    input.name = input.name.trim().to_string();
    input.host = input.host.trim().to_string();
    input.database_name = input.database_name.trim().to_string();
    input.username = input.username.trim().to_string();
    input.ssl_mode = input.ssl_mode.trim().to_ascii_lowercase();
    input.sqlite_path = input.sqlite_path.trim().to_string();

    if input.name.is_empty() || input.name.len() > 128 {
        return Err(DatabaseCommandError::invalid(
            "The profile name must contain 1 to 128 characters.",
        ));
    }
    input.query_timeout_ms = input
        .query_timeout_ms
        .clamp(MIN_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS);
    input.max_rows = input.max_rows.clamp(1, HARD_MAX_ROWS);
    input.max_affected_rows = input.max_affected_rows.clamp(1, HARD_MAX_AFFECTED_ROWS);

    match input.driver {
        DatabaseDriver::Sqlite => {
            if input.sqlite_path.is_empty() || input.sqlite_path.len() > 32_768 {
                return Err(DatabaseCommandError::invalid(
                    "A valid SQLite database path is required.",
                ));
            }
            input.host.clear();
            input.port = 0;
            input.database_name.clear();
            input.username.clear();
            input.ssl_mode = "disable".to_string();
        }
        DatabaseDriver::Postgresql | DatabaseDriver::Mysql => {
            if input.host.is_empty() || input.host.len() > 255 {
                return Err(DatabaseCommandError::invalid(
                    "A valid database host is required.",
                ));
            }
            if input.port == 0 {
                return Err(DatabaseCommandError::invalid(
                    "A valid database port is required.",
                ));
            }
            if input.database_name.is_empty() || input.database_name.len() > 255 {
                return Err(DatabaseCommandError::invalid(
                    "A valid database name is required.",
                ));
            }
            if input.username.is_empty() || input.username.len() > 128 {
                return Err(DatabaseCommandError::invalid(
                    "A valid database username is required.",
                ));
            }
            validate_ssl_mode(input.driver, &input.ssl_mode)?;
            input.sqlite_path.clear();
        }
    }
    Ok(input)
}

fn validate_ssl_mode(driver: DatabaseDriver, ssl_mode: &str) -> Result<(), DatabaseCommandError> {
    let valid = match driver {
        DatabaseDriver::Sqlite => ssl_mode == "disable",
        DatabaseDriver::Postgresql => matches!(
            ssl_mode,
            "disable" | "prefer" | "require" | "verify_ca" | "verify_full"
        ),
        DatabaseDriver::Mysql => matches!(
            ssl_mode,
            "disable" | "prefer" | "require" | "verify_ca" | "verify_full" | "verify_identity"
        ),
    };
    if !valid {
        return Err(DatabaseCommandError::invalid(
            "The selected TLS mode is not supported by this database driver.",
        ));
    }
    Ok(())
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseProfileInput> {
    let driver: String = row.get(2)?;
    let driver = match driver.as_str() {
        "sqlite" => DatabaseDriver::Sqlite,
        "postgresql" => DatabaseDriver::Postgresql,
        "mysql" => DatabaseDriver::Mysql,
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                2,
                "driver".to_string(),
                rusqlite::types::Type::Text,
            ));
        }
    };
    Ok(DatabaseProfileInput {
        id: row.get(0)?,
        name: row.get(1)?,
        driver,
        host: row.get(3)?,
        port: row.get::<_, u16>(4)?,
        database_name: row.get(5)?,
        username: row.get(6)?,
        ssl_mode: row.get(7)?,
        sqlite_path: row.get(8)?,
        enabled: row.get::<_, i64>(9)? != 0,
        allow_writes: row.get::<_, i64>(10)? != 0,
        query_timeout_ms: row.get::<_, i64>(11)?.max(0) as u64,
        max_rows: row.get::<_, i64>(12)?.max(0) as usize,
        max_affected_rows: row.get::<_, i64>(13)?.max(0) as u64,
    })
}

const PROFILE_SELECT: &str = "
    SELECT id, name, driver, host, port, database_name, username, ssl_mode,
           sqlite_path, enabled, allow_writes, query_timeout_ms, max_rows,
           max_affected_rows
    FROM database_profiles
";

fn materialize_profile(
    input: DatabaseProfileInput,
) -> Result<DatabaseProfile, DatabaseCommandError> {
    let password_configured = if input.driver == DatabaseDriver::Sqlite {
        false
    } else {
        read_password(&input.id)?.is_some()
    };
    Ok(DatabaseProfile {
        id: input.id,
        name: input.name,
        driver: input.driver,
        host: input.host,
        port: input.port,
        database_name: input.database_name,
        username: input.username,
        ssl_mode: input.ssl_mode,
        sqlite_path: input.sqlite_path,
        enabled: input.enabled,
        allow_writes: input.allow_writes,
        query_timeout_ms: input.query_timeout_ms,
        max_rows: input.max_rows,
        max_affected_rows: input.max_affected_rows,
        password_configured,
    })
}

fn load_profile_input(profile_id: &str) -> Result<DatabaseProfileInput, DatabaseCommandError> {
    validate_profile_id(profile_id)?;
    let conn = open_profiles_db()?;
    conn.query_row(
        &format!("{PROFILE_SELECT} WHERE id = ?1"),
        [profile_id],
        profile_from_row,
    )
    .optional()
    .map_err(|_| {
        DatabaseCommandError::new(
            DatabaseErrorCode::StorageError,
            "Could not read the database profile.",
        )
    })?
    .ok_or_else(|| {
        DatabaseCommandError::new(
            DatabaseErrorCode::ProfileNotFound,
            "The database profile was not found.",
        )
    })
}

fn list_profiles_sync() -> Result<Vec<DatabaseProfile>, DatabaseCommandError> {
    let conn = open_profiles_db()?;
    let mut statement = conn
        .prepare(&format!(
            "{PROFILE_SELECT} ORDER BY name COLLATE NOCASE, id"
        ))
        .map_err(|_| {
            DatabaseCommandError::new(
                DatabaseErrorCode::StorageError,
                "Could not read database profiles.",
            )
        })?;
    let inputs = statement
        .query_map([], profile_from_row)
        .map_err(|_| {
            DatabaseCommandError::new(
                DatabaseErrorCode::StorageError,
                "Could not read database profiles.",
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            DatabaseCommandError::new(
                DatabaseErrorCode::StorageError,
                "Could not read database profiles.",
            )
        })?;
    inputs.into_iter().map(materialize_profile).collect()
}

fn ensure_profile_credential_will_exist(
    profile: &DatabaseProfileInput,
    update: &PasswordUpdate,
    previous_password: Option<&str>,
) -> Result<(), DatabaseCommandError> {
    if profile.driver == DatabaseDriver::Sqlite || !profile.enabled {
        return Ok(());
    }
    let configured = match update {
        PasswordUpdate::Unchanged => previous_password.is_some(),
        PasswordUpdate::Clear => false,
        PasswordUpdate::Set(value) => !value.is_empty(),
    };
    if !configured {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::PasswordRequired,
            "An enabled PostgreSQL or MySQL profile requires a password.",
        ));
    }
    Ok(())
}

fn save_profile_sync(
    input: DatabaseProfileSaveInput,
) -> Result<DatabaseProfile, DatabaseCommandError> {
    let profile = normalize_profile(input.profile)?;
    let previous_password = read_password(&profile.id)?;
    let effective_update = if profile.driver == DatabaseDriver::Sqlite {
        PasswordUpdate::Clear
    } else {
        input.password_update
    };
    ensure_profile_credential_will_exist(
        &profile,
        &effective_update,
        previous_password.as_deref(),
    )?;
    match &effective_update {
        PasswordUpdate::Unchanged => {}
        PasswordUpdate::Clear => clear_password(&profile.id)?,
        PasswordUpdate::Set(password) => {
            if password.is_empty() || password.len() > 16_384 {
                return Err(DatabaseCommandError::invalid(
                    "The database password must contain 1 to 16384 characters.",
                ));
            }
            set_password(&profile.id, password)?;
        }
    }

    let conn = open_profiles_db()?;
    let result = conn.execute(
        "
        INSERT INTO database_profiles (
            id, name, driver, host, port, database_name, username, ssl_mode,
            sqlite_path, enabled, allow_writes, query_timeout_ms, max_rows,
            max_affected_rows, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            driver = excluded.driver,
            host = excluded.host,
            port = excluded.port,
            database_name = excluded.database_name,
            username = excluded.username,
            ssl_mode = excluded.ssl_mode,
            sqlite_path = excluded.sqlite_path,
            enabled = excluded.enabled,
            allow_writes = excluded.allow_writes,
            query_timeout_ms = excluded.query_timeout_ms,
            max_rows = excluded.max_rows,
            max_affected_rows = excluded.max_affected_rows,
            updated_at = excluded.updated_at
        ",
        params![
            profile.id,
            profile.name,
            match profile.driver {
                DatabaseDriver::Sqlite => "sqlite",
                DatabaseDriver::Postgresql => "postgresql",
                DatabaseDriver::Mysql => "mysql",
            },
            profile.host,
            profile.port,
            profile.database_name,
            profile.username,
            profile.ssl_mode,
            profile.sqlite_path,
            i64::from(profile.enabled),
            i64::from(profile.allow_writes),
            profile.query_timeout_ms as i64,
            profile.max_rows as i64,
            profile.max_affected_rows as i64,
            now_ms(),
        ],
    );
    if result.is_err() {
        if !matches!(effective_update, PasswordUpdate::Unchanged) {
            restore_password(&profile.id, previous_password.as_deref());
        }
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::StorageError,
            "Could not save the database profile.",
        ));
    }
    materialize_profile(profile)
}

fn delete_profile_sync(profile_id: &str) -> Result<bool, DatabaseCommandError> {
    validate_profile_id(profile_id)?;
    let previous_password = read_password(profile_id)?;
    clear_password(profile_id)?;
    let conn = open_profiles_db()?;
    match conn.execute("DELETE FROM database_profiles WHERE id = ?1", [profile_id]) {
        Ok(count) => Ok(count > 0),
        Err(_) => {
            restore_password(profile_id, previous_password.as_deref());
            Err(DatabaseCommandError::new(
                DatabaseErrorCode::StorageError,
                "Could not delete the database profile.",
            ))
        }
    }
}

fn prepare_params(params: &[DatabaseParam]) -> Result<Vec<BoundParam>, DatabaseCommandError> {
    if params.len() > MAX_PARAM_COUNT {
        return Err(DatabaseCommandError::invalid("Too many query parameters."));
    }
    let mut total_bytes = 0usize;
    let mut output = Vec::with_capacity(params.len());
    for param in params {
        let value = match param {
            DatabaseParam::Null => BoundParam::Null,
            DatabaseParam::Boolean { value } => BoundParam::Boolean(*value),
            DatabaseParam::Integer { value } => {
                let parsed = match value {
                    DatabaseIntegerParam::Number(value) => *value,
                    DatabaseIntegerParam::String(value) => value.parse::<i64>().map_err(|_| {
                        DatabaseCommandError::invalid(
                            "Integer parameters must be signed 64-bit decimal values.",
                        )
                    })?,
                };
                BoundParam::Integer(parsed)
            }
            DatabaseParam::Float { value } => {
                if !value.is_finite() {
                    return Err(DatabaseCommandError::invalid(
                        "Float parameters must be finite.",
                    ));
                }
                BoundParam::Float(*value)
            }
            DatabaseParam::Text { value } => {
                total_bytes = total_bytes.saturating_add(value.len());
                BoundParam::Text(value.clone())
            }
            DatabaseParam::BytesBase64 { value } => {
                let decoded = BASE64.decode(value).map_err(|_| {
                    DatabaseCommandError::invalid("A binary parameter is not valid Base64.")
                })?;
                total_bytes = total_bytes.saturating_add(decoded.len());
                BoundParam::Bytes(decoded)
            }
        };
        if total_bytes > MAX_PARAM_BYTES {
            return Err(DatabaseCommandError::invalid(
                "Query parameters exceed the size limit.",
            ));
        }
        output.push(value);
    }
    Ok(output)
}

#[derive(Debug, PartialEq, Eq)]
struct SqlScan {
    tokens: Vec<String>,
    top_level_tokens: Vec<String>,
}

fn scan_sql(sql: &str) -> Result<SqlScan, DatabaseCommandError> {
    if sql.trim().is_empty() || sql.len() > MAX_QUERY_BYTES {
        return Err(DatabaseCommandError::invalid(
            "SQL must contain 1 to 262144 bytes.",
        ));
    }
    let bytes = sql.as_bytes();
    let mut index = 0usize;
    let mut tokens = Vec::new();
    let mut top_level_tokens = Vec::new();
    let mut parenthesis_depth = 0usize;
    let mut terminated = false;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if index + 1 < bytes.len() && byte == b'-' && bytes[index + 1] == b'-' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index + 1 < bytes.len() && byte == b'/' && bytes[index + 1] == b'*' {
            let mysql_executable = index + 2 < bytes.len() && bytes[index + 2] == b'!';
            let mariadb_executable = index + 3 < bytes.len()
                && matches!(bytes[index + 2], b'm' | b'M')
                && bytes[index + 3] == b'!';
            if mysql_executable || mariadb_executable {
                return Err(DatabaseCommandError::new(
                    DatabaseErrorCode::QueryRejected,
                    "Executable SQL comments are not allowed.",
                ));
            }
            index += 2;
            let mut depth = 1usize;
            while index < bytes.len() && depth > 0 {
                if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
                    depth += 1;
                    index += 2;
                } else if index + 1 < bytes.len()
                    && bytes[index] == b'*'
                    && bytes[index + 1] == b'/'
                {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            if depth != 0 {
                return Err(DatabaseCommandError::invalid(
                    "SQL contains an unterminated comment.",
                ));
            }
            continue;
        }
        if terminated {
            return Err(DatabaseCommandError::new(
                DatabaseErrorCode::QueryRejected,
                "Only one SQL statement is allowed.",
            ));
        }
        if byte == b';' {
            terminated = true;
            index += 1;
            continue;
        }
        if byte == b'(' {
            parenthesis_depth = parenthesis_depth.saturating_add(1);
            index += 1;
            continue;
        }
        if byte == b')' {
            parenthesis_depth = parenthesis_depth.checked_sub(1).ok_or_else(|| {
                DatabaseCommandError::invalid("SQL contains unbalanced parentheses.")
            })?;
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            let quote = byte;
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == b'\\' && quote != b'"' {
                    index = (index + 2).min(bytes.len());
                } else if bytes[index] == quote {
                    if index + 1 < bytes.len() && bytes[index + 1] == quote {
                        index += 2;
                    } else {
                        index += 1;
                        closed = true;
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            if !closed {
                return Err(DatabaseCommandError::invalid(
                    "SQL contains an unterminated quoted value.",
                ));
            }
            continue;
        }
        if byte == b'[' {
            index += 1;
            while index < bytes.len() && bytes[index] != b']' {
                index += 1;
            }
            if index == bytes.len() {
                return Err(DatabaseCommandError::invalid(
                    "SQL contains an unterminated identifier.",
                ));
            }
            index += 1;
            continue;
        }
        if byte == b'$' {
            if let Some(relative_end) = bytes[index + 1..].iter().position(|value| *value == b'$') {
                let delimiter_end = index + relative_end + 2;
                let tag = &bytes[index + 1..delimiter_end - 1];
                if tag
                    .iter()
                    .all(|value| value.is_ascii_alphanumeric() || *value == b'_')
                    && (tag.is_empty() || !tag[0].is_ascii_digit())
                {
                    let delimiter = &bytes[index..delimiter_end];
                    let remaining = &bytes[delimiter_end..];
                    let closing = remaining
                        .windows(delimiter.len())
                        .position(|window| window == delimiter)
                        .ok_or_else(|| {
                            DatabaseCommandError::invalid(
                                "SQL contains an unterminated dollar-quoted value.",
                            )
                        })?;
                    index = delimiter_end + closing + delimiter.len();
                    continue;
                }
            }
        }
        if byte.is_ascii_alphabetic() || byte == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            let token = sql[start..index].to_ascii_lowercase();
            if parenthesis_depth == 0 {
                top_level_tokens.push(token.clone());
            }
            tokens.push(token);
        } else {
            index += 1;
        }
    }
    if tokens.is_empty() {
        return Err(DatabaseCommandError::invalid("SQL contains no statement."));
    }
    if parenthesis_depth != 0 {
        return Err(DatabaseCommandError::invalid(
            "SQL contains unbalanced parentheses.",
        ));
    }
    Ok(SqlScan {
        tokens,
        top_level_tokens,
    })
}

fn enforce_read_policy(sql: &str) -> Result<(), DatabaseCommandError> {
    let scan = scan_sql(sql)?;
    let first = scan.tokens.first().map(String::as_str).unwrap_or_default();
    if !matches!(first, "select" | "with" | "values" | "explain") {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::QueryRejected,
            "Only read-only SQL queries are allowed.",
        ));
    }
    let forbidden: HashSet<&str> = [
        "alter",
        "analyze",
        "attach",
        "begin",
        "call",
        "commit",
        "copy",
        "create",
        "delete",
        "detach",
        "do",
        "drop",
        "dumpfile",
        "execute",
        "grant",
        "insert",
        "into",
        "load_file",
        "lock",
        "lo_export",
        "lo_import",
        "merge",
        "outfile",
        "pg_ls_dir",
        "pg_read_binary_file",
        "pg_read_file",
        "pragma",
        "reindex",
        "release",
        "replace",
        "revoke",
        "rollback",
        "savepoint",
        "set",
        "truncate",
        "update",
        "vacuum",
    ]
    .into_iter()
    .collect();
    if scan
        .tokens
        .iter()
        .any(|token| forbidden.contains(token.as_str()))
    {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::QueryRejected,
            "The SQL query contains an operation that is not read-only.",
        ));
    }
    Ok(())
}

fn enforce_write_policy(sql: &str) -> Result<(), DatabaseCommandError> {
    let scan = scan_sql(sql)?;
    let first = scan.tokens.first().map(String::as_str).unwrap_or_default();
    if !matches!(first, "insert" | "update" | "delete") {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::QueryRejected,
            "Only INSERT, UPDATE, and DELETE statements are allowed.",
        ));
    }
    if matches!(first, "update" | "delete")
        && !scan.top_level_tokens.iter().any(|token| token == "where")
    {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::QueryRejected,
            "UPDATE and DELETE statements must include a WHERE clause.",
        ));
    }
    let forbidden: HashSet<&str> = [
        "alter",
        "attach",
        "begin",
        "call",
        "commit",
        "copy",
        "create",
        "detach",
        "drop",
        "execute",
        "grant",
        "lock",
        "merge",
        "pragma",
        "reindex",
        "release",
        "replace",
        "revoke",
        "rollback",
        "savepoint",
        "truncate",
        "vacuum",
    ]
    .into_iter()
    .collect();
    if scan.tokens[1..]
        .iter()
        .any(|token| forbidden.contains(token.as_str()))
    {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::QueryRejected,
            "The SQL statement contains a disallowed operation.",
        ));
    }
    Ok(())
}

struct RuntimeProfile {
    profile: DatabaseProfileInput,
    password: Option<String>,
    ephemeral: bool,
}

fn load_runtime_profile(profile_id: &str) -> Result<RuntimeProfile, DatabaseCommandError> {
    let profile = load_profile_input(profile_id)?;
    let password = match profile.driver {
        DatabaseDriver::Sqlite => None,
        DatabaseDriver::Postgresql | DatabaseDriver::Mysql => {
            Some(read_password(&profile.id)?.ok_or_else(|| {
                DatabaseCommandError::new(
                    DatabaseErrorCode::PasswordRequired,
                    "No password is configured for this database profile.",
                )
            })?)
        }
    };
    Ok(RuntimeProfile {
        profile,
        password,
        ephemeral: false,
    })
}

fn ephemeral_runtime_profile(
    connection: DatabaseConnectionInput,
) -> Result<RuntimeProfile, DatabaseCommandError> {
    let DatabaseConnectionInput {
        driver,
        host,
        port,
        database_name,
        username,
        password,
        ssl_mode,
        sqlite_path,
    } = connection;
    if password.as_ref().is_some_and(|value| value.len() > 16_384) {
        return Err(DatabaseCommandError::invalid(
            "The database password is too long.",
        ));
    }
    let profile = normalize_profile(DatabaseProfileInput {
        id: "ephemeral".to_string(),
        name: "Ephemeral connection".to_string(),
        driver,
        host,
        port: if port == 0 {
            match driver {
                DatabaseDriver::Postgresql => 5432,
                DatabaseDriver::Mysql => 3306,
                DatabaseDriver::Sqlite => 0,
            }
        } else {
            port
        },
        database_name,
        username,
        ssl_mode,
        sqlite_path,
        enabled: true,
        allow_writes: true,
        query_timeout_ms: DEFAULT_QUERY_TIMEOUT_MS,
        max_rows: DEFAULT_MAX_ROWS,
        max_affected_rows: DEFAULT_MAX_AFFECTED_ROWS,
    })?;
    Ok(RuntimeProfile {
        profile,
        password,
        ephemeral: true,
    })
}

fn resolve_runtime_profile(
    profile_id: Option<String>,
    connection: Option<DatabaseConnectionInput>,
) -> Result<RuntimeProfile, DatabaseCommandError> {
    match (profile_id, connection) {
        (Some(profile_id), None) => {
            let runtime = load_runtime_profile(profile_id.trim())?;
            ensure_runtime_profile_enabled(runtime)
        }
        (None, Some(connection)) => ephemeral_runtime_profile(connection),
        (Some(_), Some(_)) => Err(DatabaseCommandError::invalid(
            "Provide either profileId or connection, not both.",
        )),
        (None, None) => Err(DatabaseCommandError::invalid(
            "Either profileId or connection is required.",
        )),
    }
}

fn ensure_runtime_profile_enabled(
    runtime: RuntimeProfile,
) -> Result<RuntimeProfile, DatabaseCommandError> {
    if !runtime.ephemeral && !runtime.profile.enabled {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::ProfileDisabled,
            "The database profile is disabled.",
        ));
    }
    Ok(runtime)
}

fn resolve_execute_runtime_profile(
    profile_id: Option<String>,
    connection: Option<DatabaseConnectionInput>,
) -> Result<RuntimeProfile, DatabaseCommandError> {
    if connection.is_some() {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::WriteNotAuthorized,
            "Writes through temporary database connections are not authorized.",
        ));
    }
    resolve_runtime_profile(profile_id, None)
}

fn effective_timeout(profile: &DatabaseProfileInput, requested: Option<u64>) -> Duration {
    let requested = requested
        .unwrap_or(profile.query_timeout_ms)
        .clamp(MIN_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS);
    Duration::from_millis(requested.min(profile.query_timeout_ms))
}

fn effective_max_rows(profile: &DatabaseProfileInput, requested: Option<usize>) -> usize {
    requested
        .unwrap_or(profile.max_rows)
        .clamp(1, HARD_MAX_ROWS)
        .min(profile.max_rows)
}

fn effective_max_affected_rows(profile: &DatabaseProfileInput, requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(profile.max_affected_rows)
        .clamp(1, HARD_MAX_AFFECTED_ROWS)
        .min(profile.max_affected_rows)
}

fn validate_catalog_name(value: &str, label: &str) -> Result<(), DatabaseCommandError> {
    if value.is_empty() || value.len() > 255 || value.contains('\0') {
        return Err(DatabaseCommandError::invalid(format!(
            "A valid {label} is required."
        )));
    }
    Ok(())
}

fn prepare_query(
    profile: &DatabaseProfileInput,
    input: DatabaseQueryInput,
) -> Result<(String, Vec<BoundParam>, usize, Duration), DatabaseCommandError> {
    let max_rows = effective_max_rows(profile, input.max_rows);
    let timeout = effective_timeout(profile, input.timeout_ms);
    let (sql, params) = match input.action {
        DatabaseQueryAction::Query => {
            let sql = input
                .sql
                .ok_or_else(|| DatabaseCommandError::invalid("SQL is required."))?;
            enforce_read_policy(&sql)?;
            (sql, prepare_params(&input.params)?)
        }
        DatabaseQueryAction::ListTables => {
            if !input.params.is_empty() {
                return Err(DatabaseCommandError::invalid(
                    "Catalog queries do not accept custom parameters.",
                ));
            }
            match profile.driver {
                DatabaseDriver::Sqlite => (
                    "SELECT name AS table_name, type AS table_type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name".to_string(),
                    Vec::new(),
                ),
                DatabaseDriver::Postgresql => (
                    "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name".to_string(),
                    Vec::new(),
                ),
                DatabaseDriver::Mysql => (
                    "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name".to_string(),
                    Vec::new(),
                ),
            }
        }
        DatabaseQueryAction::DescribeTable => {
            if !input.params.is_empty() {
                return Err(DatabaseCommandError::invalid(
                    "Catalog queries do not accept custom parameters.",
                ));
            }
            let table = input.table.unwrap_or_default().trim().to_string();
            validate_catalog_name(&table, "table name")?;
            match profile.driver {
                DatabaseDriver::Sqlite => (
                    "SELECT name AS column_name, type AS data_type, CASE \"notnull\" WHEN 0 THEN 'YES' ELSE 'NO' END AS is_nullable, dflt_value AS column_default, pk AS primary_key FROM pragma_table_info(?1) ORDER BY cid".to_string(),
                    vec![BoundParam::Text(table)],
                ),
                DatabaseDriver::Postgresql => {
                    let schema = input.schema.unwrap_or_else(|| "public".to_string());
                    let schema = schema.trim().to_string();
                    validate_catalog_name(&schema, "schema name")?;
                    (
                        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position".to_string(),
                        vec![BoundParam::Text(schema), BoundParam::Text(table)],
                    )
                }
                DatabaseDriver::Mysql => {
                    let schema = input
                        .schema
                        .unwrap_or_else(|| profile.database_name.clone());
                    let schema = schema.trim().to_string();
                    validate_catalog_name(&schema, "schema name")?;
                    (
                        "SELECT column_name, data_type, is_nullable, column_default, column_key, extra FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position".to_string(),
                        vec![BoundParam::Text(schema), BoundParam::Text(table)],
                    )
                }
            }
        }
    };
    Ok((sql, params, max_rows, timeout))
}

fn sqlite_values(params: &[BoundParam]) -> Vec<SqliteValue> {
    params
        .iter()
        .map(|value| match value {
            BoundParam::Null => SqliteValue::Null,
            BoundParam::Boolean(value) => SqliteValue::Integer(i64::from(*value)),
            BoundParam::Integer(value) => SqliteValue::Integer(*value),
            BoundParam::Float(value) => SqliteValue::Real(*value),
            BoundParam::Text(value) => SqliteValue::Text(value.clone()),
            BoundParam::Bytes(value) => SqliteValue::Blob(value.clone()),
        })
        .collect()
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn null_cell() -> DatabaseCell {
    DatabaseCell {
        cell_type: "null".to_string(),
        value: None,
        truncated: false,
    }
}

fn scalar_cell(cell_type: &str, value: JsonValue) -> DatabaseCell {
    DatabaseCell {
        cell_type: cell_type.to_string(),
        value: Some(value),
        truncated: false,
    }
}

fn bounded_text_cell(cell_type: &str, value: &str) -> (DatabaseCell, usize) {
    if value.len() <= MAX_CELL_BYTES {
        return (
            scalar_cell(cell_type, JsonValue::String(value.to_string())),
            value.len(),
        );
    }
    let mut end = MAX_CELL_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (
        DatabaseCell {
            cell_type: cell_type.to_string(),
            value: Some(JsonValue::String(value[..end].to_string())),
            truncated: true,
        },
        end,
    )
}

fn bounded_bytes_cell(value: &[u8]) -> (DatabaseCell, usize) {
    let max_raw = MAX_CELL_BYTES / 4 * 3;
    let truncated = value.len() > max_raw;
    let bytes = if truncated { &value[..max_raw] } else { value };
    let encoded = BASE64.encode(bytes);
    (
        DatabaseCell {
            cell_type: "bytes_base64".to_string(),
            value: Some(JsonValue::String(encoded.clone())),
            truncated,
        },
        encoded.len(),
    )
}

fn json_number_cell(value: f64) -> (DatabaseCell, usize) {
    match JsonNumber::from_f64(value) {
        Some(number) => {
            let len = number.to_string().len();
            (scalar_cell("float", JsonValue::Number(number)), len)
        }
        None => bounded_text_cell("text", &value.to_string()),
    }
}

fn sqlite_cell(value: SqliteValueRef<'_>) -> (DatabaseCell, usize) {
    match value {
        SqliteValueRef::Null => (null_cell(), 0),
        SqliteValueRef::Integer(value) => bounded_text_cell("integer", &value.to_string()),
        SqliteValueRef::Real(value) => json_number_cell(value),
        SqliteValueRef::Text(value) => {
            let value = String::from_utf8_lossy(value);
            bounded_text_cell("text", &value)
        }
        SqliteValueRef::Blob(value) => bounded_bytes_cell(value),
    }
}

fn sqlite_open_read_only(
    path: &str,
    busy_timeout: Duration,
) -> Result<SqliteConnection, DatabaseCommandError> {
    let conn = SqliteConnection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| DatabaseCommandError::connection())?;
    conn.busy_timeout(busy_timeout)
        .map_err(|_| DatabaseCommandError::connection())?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|_| DatabaseCommandError::connection())?;
    Ok(conn)
}

fn sqlite_query_sync(
    path: String,
    sql: String,
    params: Vec<BoundParam>,
    max_rows: usize,
    timeout: Duration,
) -> Result<DatabaseQueryResult, DatabaseCommandError> {
    let started = Instant::now();
    let deadline = started + timeout;
    let conn = sqlite_open_read_only(&path, timeout)?;
    conn.progress_handler(1_000, Some(move || Instant::now() >= deadline))
        .map_err(|_| DatabaseCommandError::database())?;
    let mut statement = conn
        .prepare(&sql)
        .map_err(|_| DatabaseCommandError::database())?;
    if statement.column_count() == 0 {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::QueryRejected,
            "The SQL statement does not return rows.",
        ));
    }
    let columns = statement
        .column_names()
        .into_iter()
        .map(|name| DatabaseColumn {
            name: name.to_string(),
            type_name: "dynamic".to_string(),
        })
        .collect::<Vec<_>>();
    let values = sqlite_values(&params);
    let mut cursor = statement
        .query(params_from_iter(values.iter()))
        .map_err(|_| DatabaseCommandError::database())?;
    let mut rows = Vec::new();
    let mut result_bytes = serde_json::to_vec(&columns)
        .map_err(|_| DatabaseCommandError::database())?
        .len();
    let mut truncated = false;
    loop {
        let next = cursor.next().map_err(|_| {
            if Instant::now() >= deadline {
                DatabaseCommandError::timeout()
            } else {
                DatabaseCommandError::database()
            }
        })?;
        let Some(row) = next else { break };
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let mut output_row = Vec::with_capacity(columns.len());
        let mut cell_truncated = false;
        for index in 0..columns.len() {
            let (cell, _bytes) = sqlite_cell(
                row.get_ref(index)
                    .map_err(|_| DatabaseCommandError::database())?,
            );
            cell_truncated |= cell.truncated;
            output_row.push(cell);
        }
        let row_bytes = serde_json::to_vec(&output_row)
            .map_err(|_| DatabaseCommandError::database())?
            .len();
        if result_bytes.saturating_add(row_bytes) > MAX_RESULT_BYTES - RESULT_ENVELOPE_RESERVE_BYTES
        {
            truncated = true;
            break;
        }
        result_bytes += row_bytes;
        truncated |= cell_truncated;
        rows.push(output_row);
    }
    let row_count = rows.len();
    Ok(DatabaseQueryResult {
        profile_id: String::new(),
        columns,
        rows,
        row_count,
        truncated,
        elapsed_ms: duration_ms(started),
    })
}

fn sqlite_execute_sync(
    path: String,
    sql: String,
    params: Vec<BoundParam>,
    max_affected_rows: u64,
    timeout: Duration,
) -> Result<DatabaseExecuteResult, DatabaseCommandError> {
    let started = Instant::now();
    let deadline = started + timeout;
    let mut conn = SqliteConnection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| DatabaseCommandError::connection())?;
    conn.busy_timeout(timeout)
        .map_err(|_| DatabaseCommandError::connection())?;
    conn.progress_handler(1_000, Some(move || Instant::now() >= deadline))
        .map_err(|_| DatabaseCommandError::database())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DatabaseCommandError::database())?;
    let values = sqlite_values(&params);
    let affected = tx
        .execute(&sql, params_from_iter(values.iter()))
        .map_err(|_| {
            if Instant::now() >= deadline {
                DatabaseCommandError::timeout()
            } else {
                DatabaseCommandError::database()
            }
        })? as u64;
    if affected > max_affected_rows {
        let _ = tx.rollback();
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::LimitExceeded,
            "The write affected more rows than allowed and was rolled back.",
        ));
    }
    tx.commit().map_err(|_| DatabaseCommandError::database())?;
    Ok(DatabaseExecuteResult {
        profile_id: String::new(),
        affected_rows: affected,
        elapsed_ms: duration_ms(started),
    })
}

fn pg_ssl_mode(value: &str) -> PgSslMode {
    match value {
        "disable" => PgSslMode::Disable,
        "require" => PgSslMode::Require,
        "verify_ca" => PgSslMode::VerifyCa,
        "verify_full" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}

fn mysql_ssl_mode(value: &str) -> MySqlSslMode {
    match value {
        "disable" => MySqlSslMode::Disabled,
        "require" => MySqlSslMode::Required,
        "verify_ca" => MySqlSslMode::VerifyCa,
        "verify_full" | "verify_identity" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Preferred,
    }
}

fn pg_options(profile: &DatabaseProfileInput, password: &str) -> PgConnectOptions {
    PgConnectOptions::new()
        .host(&profile.host)
        .port(profile.port)
        .username(&profile.username)
        .password(password)
        .database(&profile.database_name)
        .ssl_mode(pg_ssl_mode(&profile.ssl_mode))
        .application_name("ArcForge")
}

fn mysql_options(profile: &DatabaseProfileInput, password: &str) -> MySqlConnectOptions {
    MySqlConnectOptions::new()
        .host(&profile.host)
        .port(profile.port)
        .username(&profile.username)
        .password(password)
        .database(&profile.database_name)
        .ssl_mode(mysql_ssl_mode(&profile.ssl_mode))
}

fn bind_pg<'q>(
    mut query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    params: &[BoundParam],
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    for param in params {
        query = match param {
            BoundParam::Null => query.bind(Option::<String>::None),
            BoundParam::Boolean(value) => query.bind(*value),
            BoundParam::Integer(value) => query.bind(*value),
            BoundParam::Float(value) => query.bind(*value),
            BoundParam::Text(value) => query.bind(value.clone()),
            BoundParam::Bytes(value) => query.bind(value.clone()),
        };
    }
    query
}

fn bind_mysql<'q>(
    mut query: sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>,
    params: &[BoundParam],
) -> sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments> {
    for param in params {
        query = match param {
            BoundParam::Null => query.bind(Option::<String>::None),
            BoundParam::Boolean(value) => query.bind(*value),
            BoundParam::Integer(value) => query.bind(*value),
            BoundParam::Float(value) => query.bind(*value),
            BoundParam::Text(value) => query.bind(value.clone()),
            BoundParam::Bytes(value) => query.bind(value.clone()),
        };
    }
    query
}

fn json_cell(value: JsonValue) -> (DatabaseCell, usize) {
    let encoded = value.to_string();
    if encoded.len() <= MAX_CELL_BYTES {
        (scalar_cell("json", value), encoded.len())
    } else {
        bounded_text_cell("json_text", &encoded)
    }
}

fn unsupported_cell() -> (DatabaseCell, usize) {
    (
        DatabaseCell {
            cell_type: "unsupported".to_string(),
            value: None,
            truncated: false,
        },
        0,
    )
}

fn pg_cell(
    row: &PgRow,
    index: usize,
    type_name: &str,
) -> Result<(DatabaseCell, usize), DatabaseCommandError> {
    if row
        .try_get_raw(index)
        .map_err(|_| DatabaseCommandError::database())?
        .is_null()
    {
        return Ok((null_cell(), 0));
    }
    let upper = type_name.to_ascii_uppercase();
    let result = match upper.as_str() {
        "BOOL" => {
            let value: bool = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            (scalar_cell("boolean", JsonValue::Bool(value)), 1)
        }
        "INT2" => {
            let value: i16 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("integer", &value.to_string())
        }
        "INT4" => {
            let value: i32 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("integer", &value.to_string())
        }
        "INT8" => {
            let value: i64 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("integer", &value.to_string())
        }
        "OID" => {
            let value: sqlx::postgres::types::Oid = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("integer", &value.0.to_string())
        }
        "FLOAT4" => {
            let value: f32 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            json_number_cell(f64::from(value))
        }
        "FLOAT8" => {
            let value: f64 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            json_number_cell(value)
        }
        "NUMERIC" => row
            .try_get_unchecked::<String, _>(index)
            .map(|value| bounded_text_cell("decimal", &value))
            .unwrap_or_else(|_| unsupported_cell()),
        "BYTEA" => {
            let value: Vec<u8> = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_bytes_cell(&value)
        }
        "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" | "CITEXT" | "UNKNOWN" => {
            let value: String = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("text", &value)
        }
        "JSON" | "JSONB" => {
            let value: JsonValue = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            json_cell(value)
        }
        "UUID" => {
            let value: Uuid = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("text", &value.to_string())
        }
        "DATE" => {
            let value: NaiveDate = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("date", &value.to_string())
        }
        "TIME" => {
            let value: NaiveTime = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("time", &value.to_string())
        }
        "TIMESTAMP" => {
            let value: NaiveDateTime = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("datetime", &value.to_string())
        }
        "TIMESTAMPTZ" => {
            let value: DateTime<Utc> = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("datetime", &value.to_rfc3339())
        }
        _ => unsupported_cell(),
    };
    Ok(result)
}

fn mysql_cell(
    row: &MySqlRow,
    index: usize,
    type_name: &str,
) -> Result<(DatabaseCell, usize), DatabaseCommandError> {
    if row
        .try_get_raw(index)
        .map_err(|_| DatabaseCommandError::database())?
        .is_null()
    {
        return Ok((null_cell(), 0));
    }
    let upper = type_name.to_ascii_uppercase();
    let result = match upper.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => {
            if let Ok(value) = row.try_get::<i64, _>(index) {
                bounded_text_cell("integer", &value.to_string())
            } else {
                let value: u64 = row
                    .try_get(index)
                    .map_err(|_| DatabaseCommandError::database())?;
                bounded_text_cell("integer", &value.to_string())
            }
        }
        "FLOAT" => {
            let value: f32 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            json_number_cell(f64::from(value))
        }
        "DOUBLE" => {
            let value: f64 = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            json_number_cell(value)
        }
        "DECIMAL" | "NEWDECIMAL" => row
            .try_get_unchecked::<String, _>(index)
            .map(|value| bounded_text_cell("decimal", &value))
            .unwrap_or_else(|_| unsupported_cell()),
        "BIT" | "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            let value: Vec<u8> = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_bytes_cell(&value)
        }
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            let value: String = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("text", &value)
        }
        "JSON" => {
            let value: JsonValue = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            json_cell(value)
        }
        "DATE" => {
            let value: NaiveDate = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("date", &value.to_string())
        }
        "TIME" => {
            let value: NaiveTime = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("time", &value.to_string())
        }
        "DATETIME" | "TIMESTAMP" => {
            let value: NaiveDateTime = row
                .try_get(index)
                .map_err(|_| DatabaseCommandError::database())?;
            bounded_text_cell("datetime", &value.to_string())
        }
        _ => unsupported_cell(),
    };
    Ok(result)
}

fn push_pg_row(
    row: &PgRow,
    columns: &[DatabaseColumn],
    rows: &mut Vec<Vec<DatabaseCell>>,
    result_bytes: &mut usize,
    truncated: &mut bool,
) -> Result<bool, DatabaseCommandError> {
    let mut output = Vec::with_capacity(columns.len());
    let mut cell_truncated = false;
    for (index, column) in columns.iter().enumerate() {
        let (cell, _bytes) = pg_cell(row, index, &column.type_name)?;
        cell_truncated |= cell.truncated;
        output.push(cell);
    }
    let row_bytes = serde_json::to_vec(&output)
        .map_err(|_| DatabaseCommandError::database())?
        .len();
    if result_bytes.saturating_add(row_bytes) > MAX_RESULT_BYTES - RESULT_ENVELOPE_RESERVE_BYTES {
        *truncated = true;
        return Ok(false);
    }
    *result_bytes += row_bytes;
    *truncated |= cell_truncated;
    rows.push(output);
    Ok(true)
}

fn push_mysql_row(
    row: &MySqlRow,
    columns: &[DatabaseColumn],
    rows: &mut Vec<Vec<DatabaseCell>>,
    result_bytes: &mut usize,
    truncated: &mut bool,
) -> Result<bool, DatabaseCommandError> {
    let mut output = Vec::with_capacity(columns.len());
    let mut cell_truncated = false;
    for (index, column) in columns.iter().enumerate() {
        let (cell, _bytes) = mysql_cell(row, index, &column.type_name)?;
        cell_truncated |= cell.truncated;
        output.push(cell);
    }
    let row_bytes = serde_json::to_vec(&output)
        .map_err(|_| DatabaseCommandError::database())?
        .len();
    if result_bytes.saturating_add(row_bytes) > MAX_RESULT_BYTES - RESULT_ENVELOPE_RESERVE_BYTES {
        *truncated = true;
        return Ok(false);
    }
    *result_bytes += row_bytes;
    *truncated |= cell_truncated;
    rows.push(output);
    Ok(true)
}

async fn pg_query(
    profile: &DatabaseProfileInput,
    password: &str,
    sql: &str,
    params: &[BoundParam],
    max_rows: usize,
) -> Result<DatabaseQueryResult, DatabaseCommandError> {
    let started = Instant::now();
    let mut conn = PgConnection::connect_with(&pg_options(profile, password))
        .await
        .map_err(|_| DatabaseCommandError::connection())?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut result_bytes = 0usize;
    let mut truncated = false;
    {
        let query = bind_pg(sqlx::query(sql), params);
        let mut stream = query.fetch(&mut *tx);
        while let Some(row) = stream
            .try_next()
            .await
            .map_err(|_| DatabaseCommandError::database())?
        {
            if columns.is_empty() {
                columns = row
                    .columns()
                    .iter()
                    .map(|column| DatabaseColumn {
                        name: column.name().to_string(),
                        type_name: column.type_info().name().to_string(),
                    })
                    .collect();
                result_bytes = serde_json::to_vec(&columns)
                    .map_err(|_| DatabaseCommandError::database())?
                    .len();
            }
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            if !push_pg_row(&row, &columns, &mut rows, &mut result_bytes, &mut truncated)? {
                break;
            }
        }
    }
    tx.rollback()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let row_count = rows.len();
    Ok(DatabaseQueryResult {
        profile_id: String::new(),
        columns,
        rows,
        row_count,
        truncated,
        elapsed_ms: duration_ms(started),
    })
}

async fn mysql_query(
    profile: &DatabaseProfileInput,
    password: &str,
    sql: &str,
    params: &[BoundParam],
    max_rows: usize,
) -> Result<DatabaseQueryResult, DatabaseCommandError> {
    let started = Instant::now();
    let mut conn = MySqlConnection::connect_with(&mysql_options(profile, password))
        .await
        .map_err(|_| DatabaseCommandError::connection())?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut conn)
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut result_bytes = 0usize;
    let mut truncated = false;
    {
        let query = bind_mysql(sqlx::query(sql), params);
        let mut stream = query.fetch(&mut *tx);
        while let Some(row) = stream
            .try_next()
            .await
            .map_err(|_| DatabaseCommandError::database())?
        {
            if columns.is_empty() {
                columns = row
                    .columns()
                    .iter()
                    .map(|column| DatabaseColumn {
                        name: column.name().to_string(),
                        type_name: column.type_info().name().to_string(),
                    })
                    .collect();
                result_bytes = serde_json::to_vec(&columns)
                    .map_err(|_| DatabaseCommandError::database())?
                    .len();
            }
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            if !push_mysql_row(&row, &columns, &mut rows, &mut result_bytes, &mut truncated)? {
                break;
            }
        }
    }
    tx.rollback()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let row_count = rows.len();
    Ok(DatabaseQueryResult {
        profile_id: String::new(),
        columns,
        rows,
        row_count,
        truncated,
        elapsed_ms: duration_ms(started),
    })
}

async fn pg_execute(
    profile: &DatabaseProfileInput,
    password: &str,
    sql: &str,
    params: &[BoundParam],
    max_affected_rows: u64,
) -> Result<DatabaseExecuteResult, DatabaseCommandError> {
    let started = Instant::now();
    let mut conn = PgConnection::connect_with(&pg_options(profile, password))
        .await
        .map_err(|_| DatabaseCommandError::connection())?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let result = bind_pg(sqlx::query(sql), params)
        .execute(&mut *tx)
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let affected = result.rows_affected();
    if affected > max_affected_rows {
        let _ = tx.rollback().await;
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::LimitExceeded,
            "The write affected more rows than allowed and was rolled back.",
        ));
    }
    tx.commit()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    Ok(DatabaseExecuteResult {
        profile_id: String::new(),
        affected_rows: affected,
        elapsed_ms: duration_ms(started),
    })
}

async fn mysql_execute(
    profile: &DatabaseProfileInput,
    password: &str,
    sql: &str,
    params: &[BoundParam],
    max_affected_rows: u64,
) -> Result<DatabaseExecuteResult, DatabaseCommandError> {
    let started = Instant::now();
    let mut conn = MySqlConnection::connect_with(&mysql_options(profile, password))
        .await
        .map_err(|_| DatabaseCommandError::connection())?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let result = bind_mysql(sqlx::query(sql), params)
        .execute(&mut *tx)
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    let affected = result.rows_affected();
    if affected > max_affected_rows {
        let _ = tx.rollback().await;
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::LimitExceeded,
            "The write affected more rows than allowed and was rolled back.",
        ));
    }
    tx.commit()
        .await
        .map_err(|_| DatabaseCommandError::database())?;
    Ok(DatabaseExecuteResult {
        profile_id: String::new(),
        affected_rows: affected,
        elapsed_ms: duration_ms(started),
    })
}

async fn test_runtime_profile(
    runtime: RuntimeProfile,
) -> Result<DatabaseConnectionTestResult, DatabaseCommandError> {
    let started = Instant::now();
    let timeout = effective_timeout(&runtime.profile, None);
    match runtime.profile.driver {
        DatabaseDriver::Sqlite => {
            let path = runtime.profile.sqlite_path;
            tokio::task::spawn_blocking(move || {
                let conn = sqlite_open_read_only(&path, timeout)?;
                conn.query_row("SELECT 1", [], |_row| Ok(()))
                    .map_err(|_| DatabaseCommandError::connection())?;
                Ok::<_, DatabaseCommandError>(())
            })
            .await
            .map_err(|_| {
                DatabaseCommandError::new(
                    DatabaseErrorCode::Internal,
                    "The database worker stopped unexpectedly.",
                )
            })??;
        }
        DatabaseDriver::Postgresql => {
            let password = runtime.password.as_deref().unwrap_or_default();
            tokio::time::timeout(timeout, async {
                let mut conn = PgConnection::connect_with(&pg_options(&runtime.profile, password))
                    .await
                    .map_err(|_| DatabaseCommandError::connection())?;
                sqlx::query("SELECT 1")
                    .execute(&mut conn)
                    .await
                    .map_err(|_| DatabaseCommandError::connection())?;
                Ok::<_, DatabaseCommandError>(())
            })
            .await
            .map_err(|_| DatabaseCommandError::timeout())??;
        }
        DatabaseDriver::Mysql => {
            let password = runtime.password.as_deref().unwrap_or_default();
            tokio::time::timeout(timeout, async {
                let mut conn =
                    MySqlConnection::connect_with(&mysql_options(&runtime.profile, password))
                        .await
                        .map_err(|_| DatabaseCommandError::connection())?;
                sqlx::query("SELECT 1")
                    .execute(&mut conn)
                    .await
                    .map_err(|_| DatabaseCommandError::connection())?;
                Ok::<_, DatabaseCommandError>(())
            })
            .await
            .map_err(|_| DatabaseCommandError::timeout())??;
        }
    }
    Ok(DatabaseConnectionTestResult {
        ok: true,
        elapsed_ms: duration_ms(started),
    })
}

async fn spawn_database_worker<T, F>(worker: F) -> Result<T, DatabaseCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, DatabaseCommandError> + Send + 'static,
{
    tokio::task::spawn_blocking(worker).await.map_err(|_| {
        DatabaseCommandError::new(
            DatabaseErrorCode::Internal,
            "The database worker stopped unexpectedly.",
        )
    })?
}

#[tauri::command]
pub async fn database_profiles_list() -> Result<Vec<DatabaseProfile>, DatabaseCommandError> {
    spawn_database_worker(list_profiles_sync).await
}

#[tauri::command]
pub async fn database_profile_save(
    input: DatabaseProfileSaveInput,
) -> Result<DatabaseProfile, DatabaseCommandError> {
    spawn_database_worker(move || save_profile_sync(input)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn database_profile_delete(profile_id: String) -> Result<bool, DatabaseCommandError> {
    spawn_database_worker(move || delete_profile_sync(&profile_id)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn database_profile_test(
    profile_id: String,
) -> Result<DatabaseConnectionTestResult, DatabaseCommandError> {
    let runtime = spawn_database_worker(move || load_runtime_profile(&profile_id)).await?;
    test_runtime_profile(runtime).await
}

#[tauri::command]
pub async fn database_query(
    mut input: DatabaseQueryInput,
) -> Result<DatabaseQueryResult, DatabaseCommandError> {
    let profile_id = input.profile_id.take();
    let connection = input.connection.take();
    let runtime =
        spawn_database_worker(move || resolve_runtime_profile(profile_id, connection)).await?;
    let response_profile_id = if runtime.ephemeral {
        "ephemeral".to_string()
    } else {
        runtime.profile.id.clone()
    };
    let (sql, params, max_rows, timeout) = prepare_query(&runtime.profile, input)?;
    let mut result = match runtime.profile.driver {
        DatabaseDriver::Sqlite => {
            let path = runtime.profile.sqlite_path;
            spawn_database_worker(move || sqlite_query_sync(path, sql, params, max_rows, timeout))
                .await
        }
        DatabaseDriver::Postgresql => {
            let password = runtime.password.as_deref().unwrap_or_default();
            tokio::time::timeout(
                timeout,
                pg_query(&runtime.profile, password, &sql, &params, max_rows),
            )
            .await
            .map_err(|_| DatabaseCommandError::timeout())?
        }
        DatabaseDriver::Mysql => {
            let password = runtime.password.as_deref().unwrap_or_default();
            tokio::time::timeout(
                timeout,
                mysql_query(&runtime.profile, password, &sql, &params, max_rows),
            )
            .await
            .map_err(|_| DatabaseCommandError::timeout())?
        }
    }?;
    result.profile_id = response_profile_id;
    Ok(result)
}

#[tauri::command]
pub async fn database_execute(
    mut input: DatabaseExecuteInput,
) -> Result<DatabaseExecuteResult, DatabaseCommandError> {
    enforce_write_policy(&input.sql)?;
    let params = prepare_params(&input.params)?;
    let profile_id = input.profile_id.take();
    let connection = input.connection.take();
    let runtime =
        spawn_database_worker(move || resolve_execute_runtime_profile(profile_id, connection))
            .await?;
    if !runtime.profile.allow_writes {
        return Err(DatabaseCommandError::new(
            DatabaseErrorCode::WriteDisabled,
            "Writes are disabled for this database profile.",
        ));
    }
    let response_profile_id = if runtime.ephemeral {
        "ephemeral".to_string()
    } else {
        runtime.profile.id.clone()
    };
    let max_affected_rows = effective_max_affected_rows(&runtime.profile, input.max_affected_rows);
    let timeout = effective_timeout(&runtime.profile, input.timeout_ms);
    let mut result = match runtime.profile.driver {
        DatabaseDriver::Sqlite => {
            let path = runtime.profile.sqlite_path;
            let sql = input.sql;
            spawn_database_worker(move || {
                sqlite_execute_sync(path, sql, params, max_affected_rows, timeout)
            })
            .await
        }
        DatabaseDriver::Postgresql => {
            let password = runtime.password.as_deref().unwrap_or_default();
            tokio::time::timeout(
                timeout,
                pg_execute(
                    &runtime.profile,
                    password,
                    &input.sql,
                    &params,
                    max_affected_rows,
                ),
            )
            .await
            .map_err(|_| DatabaseCommandError::timeout())?
        }
        DatabaseDriver::Mysql => {
            let password = runtime.password.as_deref().unwrap_or_default();
            tokio::time::timeout(
                timeout,
                mysql_execute(
                    &runtime.profile,
                    password,
                    &input.sql,
                    &params,
                    max_affected_rows,
                ),
            )
            .await
            .map_err(|_| DatabaseCommandError::timeout())?
        }
    }?;
    result.profile_id = response_profile_id;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite_profile(path: &str) -> DatabaseProfileInput {
        DatabaseProfileInput {
            id: "test-profile".to_string(),
            name: "Test".to_string(),
            driver: DatabaseDriver::Sqlite,
            host: String::new(),
            port: 0,
            database_name: String::new(),
            username: String::new(),
            ssl_mode: "disable".to_string(),
            sqlite_path: path.to_string(),
            enabled: true,
            allow_writes: false,
            query_timeout_ms: 1_000,
            max_rows: 25,
            max_affected_rows: 10,
        }
    }

    fn create_test_database() -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().expect("create sqlite temp file");
        let conn = SqliteConnection::open(file.path()).expect("open sqlite temp database");
        conn.execute_batch(
            "
            CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL);
            INSERT INTO items (name, active) VALUES ('alpha', 1), ('beta', 1), ('gamma', 0);
            ",
        )
        .expect("seed sqlite temp database");
        file
    }

    #[test]
    fn settings_schema_stores_no_database_password() {
        let conn = SqliteConnection::open_in_memory().expect("open in-memory settings db");
        crate::commands::settings::initialize_schema(&conn).expect("initialize settings schema");
        let mut statement = conn
            .prepare("PRAGMA table_info(database_profiles)")
            .expect("inspect database_profiles");
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("read table columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns");
        assert!(columns.iter().any(|column| column == "database_name"));
        assert!(columns.iter().any(|column| column == "allow_writes"));
        assert!(!columns.iter().any(|column| {
            let lower = column.to_ascii_lowercase();
            lower.contains("password") || lower.contains("secret")
        }));
    }

    #[test]
    fn profile_response_never_serializes_password() {
        let profile =
            materialize_profile(sqlite_profile("test.sqlite")).expect("materialize sqlite profile");
        let value = serde_json::to_value(profile).expect("serialize profile");
        assert_eq!(value["passwordConfigured"], false);
        assert!(value.get("password").is_none());
        assert!(value.get("dsn").is_none());
    }

    #[test]
    fn password_update_preserves_missing_null_and_string_states() {
        let profile = serde_json::json!({
            "profile": {
                "id": "sqlite-profile",
                "name": "SQLite",
                "driver": "sqlite",
                "sqlitePath": "test.sqlite"
            }
        });
        let unchanged: DatabaseProfileSaveInput =
            serde_json::from_value(profile.clone()).expect("deserialize missing password update");
        assert!(matches!(
            unchanged.password_update,
            PasswordUpdate::Unchanged
        ));

        let mut clear = profile.clone();
        clear["passwordUpdate"] = JsonValue::Null;
        let clear: DatabaseProfileSaveInput =
            serde_json::from_value(clear).expect("deserialize null password update");
        assert!(matches!(clear.password_update, PasswordUpdate::Clear));

        let mut set = profile;
        set["passwordUpdate"] = JsonValue::String("secret".to_string());
        let set: DatabaseProfileSaveInput =
            serde_json::from_value(set).expect("deserialize string password update");
        assert!(matches!(set.password_update, PasswordUpdate::Set(value) if value == "secret"));
    }

    #[test]
    fn enabled_network_profiles_require_a_password() {
        let mut profile = sqlite_profile("");
        profile.driver = DatabaseDriver::Postgresql;
        profile.host = "127.0.0.1".to_string();
        profile.port = 5432;
        profile.database_name = "app".to_string();
        profile.username = "reader".to_string();
        profile.ssl_mode = "prefer".to_string();

        let error =
            ensure_profile_credential_will_exist(&profile, &PasswordUpdate::Unchanged, None)
                .expect_err("enabled network profile without a password must be rejected");
        assert_eq!(error.code, DatabaseErrorCode::PasswordRequired);
        ensure_profile_credential_will_exist(
            &profile,
            &PasswordUpdate::Set("secret".to_string()),
            None,
        )
        .expect("a new password satisfies the requirement");

        profile.enabled = false;
        ensure_profile_credential_will_exist(&profile, &PasswordUpdate::Clear, None)
            .expect("disabled profiles may keep no credential");
    }

    #[test]
    fn sql_scanner_ignores_comments_and_quoted_keywords() {
        enforce_read_policy(
            "-- DELETE FROM hidden\nSELECT 'UPDATE x', \"insert\", $$drop table x$$ AS note;",
        )
        .expect("quoted keywords must not be treated as operations");
        let error = enforce_read_policy("SELECT 1; DELETE FROM hidden WHERE id = 1")
            .expect_err("multiple statements must be rejected");
        assert_eq!(error.code, DatabaseErrorCode::QueryRejected);
    }

    #[test]
    fn read_policy_rejects_mutation_and_transaction_control() {
        for sql in [
            "DELETE FROM items WHERE id = 1",
            "WITH changed AS (UPDATE items SET active = 0 RETURNING *) SELECT * FROM changed",
            "SELECT 1 FOR UPDATE",
            "SELECT secret FROM audit INTO OUTFILE '/tmp/export'",
            "SELECT load_file('/etc/passwd')",
            "SELECT pg_read_file('/etc/passwd')",
            "SELECT 1 /*!50000 INTO OUTFILE '/tmp/export' */",
            "SELECT 1 /*M!50701 INTO OUTFILE '/tmp/export' */",
            "PRAGMA table_info(items)",
        ] {
            assert!(
                enforce_read_policy(sql).is_err(),
                "query should be rejected: {sql}"
            );
        }
    }

    #[test]
    fn write_policy_requires_supported_statement_and_where() {
        enforce_write_policy("INSERT INTO items(name, active) VALUES (?, ?)")
            .expect("insert is allowed");
        enforce_write_policy("UPDATE items SET active = 0 WHERE id = ?")
            .expect("bounded update is allowed");
        enforce_write_policy("DELETE FROM items WHERE id = ?").expect("bounded delete is allowed");
        for sql in [
            "UPDATE items SET active = 0",
            "UPDATE items SET active = (SELECT active FROM items WHERE id = 1)",
            "DELETE FROM items",
            "CREATE TABLE nope(id INT)",
            "INSERT INTO items(name) VALUES ('x'); DROP TABLE items",
        ] {
            assert!(
                enforce_write_policy(sql).is_err(),
                "write should be rejected: {sql}"
            );
        }
        enforce_write_policy(
            "DELETE FROM items WHERE id IN (SELECT id FROM items WHERE active = 0)",
        )
        .expect("a top-level WHERE remains allowed when it contains a subquery");
    }

    #[test]
    fn typed_parameters_validate_binary_and_size() {
        let params = prepare_params(&[
            DatabaseParam::Null,
            DatabaseParam::Boolean { value: true },
            DatabaseParam::Integer {
                value: DatabaseIntegerParam::String("42".to_string()),
            },
            DatabaseParam::Float { value: 1.5 },
            DatabaseParam::Text {
                value: "hello".to_string(),
            },
            DatabaseParam::BytesBase64 {
                value: "AQID".to_string(),
            },
        ])
        .expect("valid tagged parameters");
        assert_eq!(params.len(), 6);
        assert!(matches!(&params[2], BoundParam::Integer(42)));
        assert!(matches!(&params[5], BoundParam::Bytes(bytes) if bytes == &[1, 2, 3]));
        assert!(prepare_params(&[DatabaseParam::BytesBase64 {
            value: "not-base64".to_string(),
        }])
        .is_err());
        assert!(prepare_params(&[DatabaseParam::Float { value: f64::NAN }]).is_err());
    }

    #[test]
    fn ephemeral_connection_is_validated_and_never_materialized() {
        let runtime = resolve_runtime_profile(
            None,
            Some(DatabaseConnectionInput {
                driver: DatabaseDriver::Postgresql,
                host: "127.0.0.1".to_string(),
                port: 0,
                database_name: "app".to_string(),
                username: "reader".to_string(),
                password: Some("temporary-secret".to_string()),
                ssl_mode: "prefer".to_string(),
                sqlite_path: String::new(),
            }),
        )
        .expect("valid ephemeral connection");
        assert!(runtime.ephemeral);
        assert_eq!(runtime.profile.id, "ephemeral");
        assert_eq!(runtime.profile.port, 5432);
        assert_eq!(runtime.password.as_deref(), Some("temporary-secret"));
        assert!(resolve_runtime_profile(
            Some("stored".to_string()),
            Some(DatabaseConnectionInput {
                driver: DatabaseDriver::Sqlite,
                host: String::new(),
                port: 0,
                database_name: String::new(),
                username: String::new(),
                password: None,
                ssl_mode: "disable".to_string(),
                sqlite_path: "file.sqlite".to_string(),
            })
        )
        .is_err());
    }

    #[test]
    fn disabled_saved_profiles_are_rejected_for_operations() {
        let mut profile = sqlite_profile("test.sqlite");
        profile.enabled = false;
        let error = ensure_runtime_profile_enabled(RuntimeProfile {
            profile,
            password: None,
            ephemeral: false,
        })
        .err()
        .expect("disabled profile must not execute queries");
        assert_eq!(error.code, DatabaseErrorCode::ProfileDisabled);

        let ephemeral = RuntimeProfile {
            profile: sqlite_profile("test.sqlite"),
            password: None,
            ephemeral: true,
        };
        ensure_runtime_profile_enabled(ephemeral).expect("ephemeral query remains available");
    }

    #[test]
    fn temporary_connections_can_never_be_used_for_writes() {
        let error = resolve_execute_runtime_profile(
            None,
            Some(DatabaseConnectionInput {
                driver: DatabaseDriver::Sqlite,
                host: String::new(),
                port: 0,
                database_name: String::new(),
                username: String::new(),
                password: None,
                ssl_mode: "disable".to_string(),
                sqlite_path: "test.sqlite".to_string(),
            }),
        )
        .err()
        .expect("temporary write must be rejected before connecting");
        assert_eq!(error.code, DatabaseErrorCode::WriteNotAuthorized);
    }

    #[test]
    fn query_response_uses_frontend_camel_case_shape() {
        let result = DatabaseQueryResult {
            profile_id: "ephemeral".to_string(),
            columns: vec![DatabaseColumn {
                name: "id".to_string(),
                type_name: "INT8".to_string(),
            }],
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
            elapsed_ms: 12,
        };
        let value = serde_json::to_value(result).expect("serialize query response");
        assert_eq!(value["profileId"], "ephemeral");
        assert_eq!(value["columns"][0]["dataType"], "INT8");
        assert_eq!(value["durationMs"], 12);
        assert!(value.get("elapsedMs").is_none());
    }

    #[test]
    fn sqlite_query_is_read_only_typed_and_row_limited() {
        let file = create_test_database();
        let result = sqlite_query_sync(
            file.path().to_string_lossy().into_owned(),
            "SELECT id, name, active FROM items WHERE id >= ?1 ORDER BY id".to_string(),
            vec![BoundParam::Integer(1)],
            2,
            Duration::from_secs(2),
        )
        .expect("query sqlite database");
        assert_eq!(result.row_count, 2);
        assert!(result.truncated);
        assert_eq!(result.columns[1].name, "name");
        assert_eq!(result.rows[0][0].cell_type, "integer");
        assert_eq!(
            result.rows[0][1].value,
            Some(JsonValue::String("alpha".to_string()))
        );
    }

    #[test]
    fn sqlite_read_only_connection_rejects_writes() {
        let file = create_test_database();
        let error = sqlite_query_sync(
            file.path().to_string_lossy().into_owned(),
            "UPDATE items SET active = 0 WHERE id = 1".to_string(),
            Vec::new(),
            10,
            Duration::from_secs(2),
        )
        .expect_err("read-only connection must reject writes");
        assert!(matches!(
            error.code,
            DatabaseErrorCode::DatabaseError | DatabaseErrorCode::QueryRejected
        ));
    }

    #[test]
    fn sqlite_write_rolls_back_when_affected_limit_is_exceeded() {
        let file = create_test_database();
        let error = sqlite_execute_sync(
            file.path().to_string_lossy().into_owned(),
            "UPDATE items SET active = 0 WHERE id > ?1".to_string(),
            vec![BoundParam::Integer(0)],
            1,
            Duration::from_secs(2),
        )
        .expect_err("over-limit write must roll back");
        assert_eq!(error.code, DatabaseErrorCode::LimitExceeded);
        let conn = SqliteConnection::open(file.path()).expect("reopen sqlite database");
        let active: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE active = 1", [], |row| {
                row.get(0)
            })
            .expect("count unchanged rows");
        assert_eq!(active, 2);
    }

    #[test]
    fn sqlite_write_commits_within_affected_limit() {
        let file = create_test_database();
        let result = sqlite_execute_sync(
            file.path().to_string_lossy().into_owned(),
            "UPDATE items SET active = 0 WHERE id = ?1".to_string(),
            vec![BoundParam::Integer(1)],
            1,
            Duration::from_secs(2),
        )
        .expect("bounded write should commit");
        assert_eq!(result.affected_rows, 1);
        let conn = SqliteConnection::open(file.path()).expect("reopen sqlite database");
        let active: i64 = conn
            .query_row("SELECT active FROM items WHERE id = 1", [], |row| {
                row.get(0)
            })
            .expect("read updated row");
        assert_eq!(active, 0);
    }

    #[test]
    fn individual_cells_are_capped_at_64_kib() {
        let input = "数".repeat(MAX_CELL_BYTES);
        let (cell, bytes) = bounded_text_cell("text", &input);
        assert!(cell.truncated);
        assert!(bytes <= MAX_CELL_BYTES);
        assert!(cell
            .value
            .as_ref()
            .and_then(JsonValue::as_str)
            .is_some_and(|value| value.is_char_boundary(value.len())));

        let binary = vec![7u8; MAX_CELL_BYTES];
        let (cell, bytes) = bounded_bytes_cell(&binary);
        assert!(cell.truncated);
        assert!(bytes <= MAX_CELL_BYTES);
    }

    #[test]
    fn database_errors_have_stable_codes_without_sensitive_context() {
        let error = DatabaseCommandError::database();
        let serialized = serde_json::to_string(&error).expect("serialize database error");
        assert!(serialized.contains("DB_DATABASE_ERROR"));
        assert!(!serialized.contains("SELECT"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("postgres://"));
    }
}
