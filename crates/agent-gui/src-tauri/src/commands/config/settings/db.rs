fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

fn config_dir() -> Result<PathBuf, String> {
    app_storage_dir()
}

fn default_project_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join(DEFAULT_PROJECT_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建默认工作目录失败：{e}"))?;
    Ok(dir)
}

fn default_project_workdir() -> Result<String, String> {
    Ok(default_project_dir()?.to_string_lossy().into_owned())
}

pub(crate) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("lock settings schema migration failed: {e}"))?;
    let result = initialize_schema_locked(conn);
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commit settings schema migration failed: {e}")),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn initialize_schema_locked(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS provider_settings (
            provider_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS system_settings (
            setting_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_settings (
            server_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_prompt_templates (
            template_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            prompt TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_settings (
            host_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT NOT NULL,
            password_configured INTEGER NOT NULL DEFAULT 0,
            private_key TEXT NOT NULL,
            private_key_path TEXT NOT NULL,
            private_key_configured INTEGER NOT NULL DEFAULT 0,
            private_key_passphrase TEXT NOT NULL DEFAULT '',
            private_key_passphrase_configured INTEGER NOT NULL DEFAULT 0,
            proxy_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_project_host_associations (
            project_path_key TEXT PRIMARY KEY,
            host_ids_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_known_hosts (
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            key_type TEXT NOT NULL,
            key_base64 TEXT NOT NULL,
            fingerprint_sha256 TEXT NOT NULL,
            trusted_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (host, port)
        );
        CREATE TABLE IF NOT EXISTS remote_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wecom_settings (
            config_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            gateway_mode TEXT NOT NULL DEFAULT 'local',
            local_gateway_port INTEGER NOT NULL DEFAULT 18780,
            bot_id TEXT NOT NULL DEFAULT '',
            tenant_id TEXT NOT NULL DEFAULT '',
            connector_id TEXT NOT NULL DEFAULT 'wecom-desktop',
            allow_group_messages INTEGER NOT NULL DEFAULT 0,
            access_policy_json TEXT NOT NULL DEFAULT '{\"rules\":[]}',
            aibot_secret TEXT NOT NULL DEFAULT '',
            channel_token TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS database_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            driver TEXT NOT NULL,
            host TEXT NOT NULL DEFAULT '',
            port INTEGER NOT NULL DEFAULT 0,
            database_name TEXT NOT NULL DEFAULT '',
            username TEXT NOT NULL DEFAULT '',
            ssl_mode TEXT NOT NULL DEFAULT 'prefer',
            sqlite_path TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            allow_writes INTEGER NOT NULL DEFAULT 0,
            query_timeout_ms INTEGER NOT NULL DEFAULT 15000,
            max_rows INTEGER NOT NULL DEFAULT 200,
            max_affected_rows INTEGER NOT NULL DEFAULT 100,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tunnel_settings (
            tunnel_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        -- 'agent' 登录方式已移除，遗留配置回退为密码登录（与前端 normalize 的未知值兜底一致）
        UPDATE ssh_settings SET auth_type = 'password' WHERE auth_type = 'agent';
        ",
    )
    .map_err(|e| format!("初始化设置表失败：{e}"))?;
    let has_wecom_access_policy = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(wecom_settings)")
            .map_err(|e| format!("prepare WeCom schema inspection failed: {e}"))?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("inspect WeCom schema failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read WeCom schema failed: {e}"))?;
        columns.iter().any(|column| column == "access_policy_json")
    };
    if !has_wecom_access_policy {
        conn.execute(
            "ALTER TABLE wecom_settings ADD COLUMN access_policy_json TEXT NOT NULL DEFAULT '{\"rules\":[]}'",
            [],
        )
        .map_err(|e| format!("add WeCom access policy column failed: {e}"))?;
    }
    let wecom_columns = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(wecom_settings)")
            .map_err(|e| format!("prepare WeCom runtime schema inspection failed: {e}"))?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("inspect WeCom runtime schema failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read WeCom runtime schema failed: {e}"))?;
        columns
    };
    if !wecom_columns.iter().any(|column| column == "gateway_mode") {
        conn.execute(
            "ALTER TABLE wecom_settings ADD COLUMN gateway_mode TEXT NOT NULL DEFAULT 'external'",
            [],
        )
        .map_err(|e| format!("add WeCom Gateway mode column failed: {e}"))?;
        let has_external_gateway = conn
            .query_row(
                &format!(
                    "SELECT payload_json FROM {REMOTE_SETTINGS_TABLE} WHERE config_id = 'default'"
                ),
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("read Remote settings during WeCom migration failed: {e}"))?
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| {
                value
                    .get("gatewayUrl")
                    .or_else(|| value.get("gateway_url"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .is_some();
        if !has_external_gateway {
            // A legacy setup with no Remote URL could never run its channel.
            // Move it to the new self-contained local mode while preserving
            // working external deployments exactly as configured.
            conn.execute("UPDATE wecom_settings SET gateway_mode = 'local'", [])
                .map_err(|e| {
                    format!("select local WeCom Gateway mode during migration failed: {e}")
                })?;
        }
    }
    if !wecom_columns
        .iter()
        .any(|column| column == "local_gateway_port")
    {
        conn.execute(
            "ALTER TABLE wecom_settings ADD COLUMN local_gateway_port INTEGER NOT NULL DEFAULT 18780",
            [],
        )
        .map_err(|e| format!("add WeCom local Gateway port column failed: {e}"))?;
    }
    Ok(())
}

pub(crate) fn config_db_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DB_FILENAME))
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let db_path = config_db_path()?;
    let conn = Connection::open(db_path).map_err(|e| format!("打开设置数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 SQLite busy_timeout 失败：{e}"))?;
    initialize_schema(&conn)?;
    Ok(conn)
}
use crate::runtime::app_paths::app_storage_dir;
