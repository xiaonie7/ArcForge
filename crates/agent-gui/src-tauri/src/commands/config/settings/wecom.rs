const DEFAULT_WECOM_CONNECTOR_ID: &str = "wecom-desktop";
pub(crate) const DEFAULT_WECOM_LOCAL_GATEWAY_PORT: u16 = 18_780;

fn default_wecom_local_gateway_port() -> u16 {
    DEFAULT_WECOM_LOCAL_GATEWAY_PORT
}

fn default_wecom_connector_id() -> String {
    DEFAULT_WECOM_CONNECTOR_ID.to_string()
}

fn is_supported_gateway_url(value: &str) -> bool {
    Url::parse(value.trim()).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https" | "ws" | "wss") && url.host_str().is_some()
    })
}

fn normalize_wecom_payload(mut payload: WecomSettingsPayload) -> WecomSettingsPayload {
    if payload.local_gateway_port == 0 {
        payload.local_gateway_port = default_wecom_local_gateway_port();
    }
    payload.bot_id = payload.bot_id.trim().to_string();
    payload.tenant_id = payload.tenant_id.trim().to_string();
    if payload.tenant_id.is_empty() {
        payload.tenant_id = payload.bot_id.clone();
    }
    payload.connector_id = payload.connector_id.trim().to_string();
    if payload.connector_id.is_empty() {
        payload.connector_id = default_wecom_connector_id();
    }
    payload
}

fn public_wecom_settings(runtime: &RuntimeWecomSettings) -> WecomSettingsPayload {
    WecomSettingsPayload {
        enabled: runtime.enabled,
        gateway_mode: runtime.gateway_mode,
        local_gateway_port: runtime.local_gateway_port,
        bot_id: runtime.bot_id.clone(),
        secret_configured: !runtime.secret.is_empty(),
        channel_token_configured: !runtime.channel_token.is_empty(),
        tenant_id: runtime.tenant_id.clone(),
        connector_id: runtime.connector_id.clone(),
        allow_group_messages: runtime.allow_group_messages,
    }
}

fn load_wecom_runtime_settings_inner(conn: &Connection) -> Result<RuntimeWecomSettings, String> {
    let row = conn
        .query_row(
            &format!(
                "SELECT enabled, gateway_mode, local_gateway_port, bot_id, tenant_id, connector_id, allow_group_messages, aibot_secret, channel_token \
                 FROM {WECOM_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| {
                let gateway_mode = match row.get::<_, String>(1)?.trim() {
                    "local" => WecomGatewayMode::Local,
                    _ => WecomGatewayMode::External,
                };
                Ok(RuntimeWecomSettings {
                    enabled: row.get::<_, i64>(0)? != 0,
                    gateway_mode,
                    local_gateway_port: row.get::<_, u16>(2)?,
                    bot_id: row.get(3)?,
                    tenant_id: row.get(4)?,
                    connector_id: row.get(5)?,
                    allow_group_messages: row.get::<_, i64>(6)? != 0,
                    secret: row.get(7)?,
                    channel_token: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("read {WECOM_SETTINGS_TABLE} failed: {e}"))?;

    Ok(row.unwrap_or_else(|| RuntimeWecomSettings {
        enabled: false,
        gateway_mode: WecomGatewayMode::Local,
        local_gateway_port: default_wecom_local_gateway_port(),
        bot_id: String::new(),
        tenant_id: String::new(),
        connector_id: default_wecom_connector_id(),
        allow_group_messages: false,
        secret: String::new(),
        channel_token: String::new(),
    }))
}

/// Runtime-only accessor for the desktop WeCom connector. Callers must keep
/// the returned credentials in process memory and must never serialize them.
pub(crate) fn load_wecom_runtime_settings(
    conn: &Connection,
) -> Result<RuntimeWecomSettings, String> {
    load_wecom_runtime_settings_inner(conn)
}

pub(crate) fn load_wecom_settings(conn: &Connection) -> Result<WecomSettingsPayload, String> {
    Ok(public_wecom_settings(&load_wecom_runtime_settings_inner(
        conn,
    )?))
}

fn write_wecom_runtime_settings(
    conn: &mut Connection,
    runtime: &RuntimeWecomSettings,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin {WECOM_SETTINGS_TABLE} transaction failed: {e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {WECOM_SETTINGS_TABLE} \
             (config_id, enabled, gateway_mode, local_gateway_port, bot_id, tenant_id, connector_id, allow_group_messages, \
              aibot_secret, channel_token, updated_at) \
             VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(config_id) DO UPDATE SET \
              enabled = excluded.enabled, \
              gateway_mode = excluded.gateway_mode, \
              local_gateway_port = excluded.local_gateway_port, \
              bot_id = excluded.bot_id, \
              tenant_id = excluded.tenant_id, \
              connector_id = excluded.connector_id, \
              allow_group_messages = excluded.allow_group_messages, \
              aibot_secret = excluded.aibot_secret, \
              channel_token = excluded.channel_token, \
              updated_at = excluded.updated_at"
        ),
        params![
            if runtime.enabled { 1i64 } else { 0i64 },
            match runtime.gateway_mode {
                WecomGatewayMode::Local => "local",
                WecomGatewayMode::External => "external",
            },
            runtime.local_gateway_port,
            &runtime.bot_id,
            &runtime.tenant_id,
            &runtime.connector_id,
            if runtime.allow_group_messages {
                1i64
            } else {
                0i64
            },
            &runtime.secret,
            &runtime.channel_token,
            now_ms(),
        ],
    )
    .map_err(|e| format!("write {WECOM_SETTINGS_TABLE} failed: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit {WECOM_SETTINGS_TABLE} failed: {e}"))?;
    Ok(())
}

/// The optional update fields are intentionally write-only. Missing fields
/// preserve existing credentials; JSON null explicitly clears one credential.
pub(crate) fn save_wecom(
    conn: &mut Connection,
    payload: Value,
) -> Result<WecomSettingsPayload, String> {
    let mut object = expect_object(payload, "settings_save_wecom payload")?;
    let secret_update = match object.remove("secretUpdate") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Some(Some(value)),
        Some(Value::String(_)) => {
            return Err("settings_save_wecom secretUpdate cannot be empty".to_string())
        }
        Some(_) => {
            return Err("settings_save_wecom secretUpdate must be a string or null".to_string())
        }
    };
    let channel_token_update = match object.remove("channelTokenUpdate") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Some(Some(value)),
        Some(Value::String(_)) => {
            return Err("settings_save_wecom channelTokenUpdate cannot be empty".to_string())
        }
        Some(_) => {
            return Err(
                "settings_save_wecom channelTokenUpdate must be a string or null".to_string(),
            )
        }
    };

    let requested = normalize_wecom_payload(
        serde_json::from_value(Value::Object(object))
            .map_err(|e| format!("parse WeCom settings failed: {e}"))?,
    );
    let mut runtime = load_wecom_runtime_settings_inner(conn)?;
    runtime.enabled = requested.enabled;
    runtime.gateway_mode = requested.gateway_mode;
    runtime.local_gateway_port = requested.local_gateway_port;
    runtime.bot_id = requested.bot_id;
    runtime.tenant_id = requested.tenant_id;
    runtime.connector_id = requested.connector_id;
    runtime.allow_group_messages = requested.allow_group_messages;

    if let Some(update) = secret_update {
        match update {
            Some(value) => runtime.secret = value.trim().to_string(),
            None => {
                runtime.secret.clear();
                runtime.enabled = false;
            }
        }
    }
    if let Some(update) = channel_token_update {
        match update {
            Some(value) => runtime.channel_token = value.trim().to_string(),
            None => {
                runtime.channel_token.clear();
                if runtime.gateway_mode == WecomGatewayMode::External {
                    runtime.enabled = false;
                }
            }
        }
    }

    if runtime.enabled {
        if runtime.bot_id.is_empty() {
            return Err("WeCom connector requires a Bot ID before it can be enabled".to_string());
        }
        if runtime.secret.is_empty() {
            return Err(
                "WeCom connector requires an AiBot Secret before it can be enabled".to_string(),
            );
        }
        if runtime.gateway_mode == WecomGatewayMode::External {
            let remote = load_remote_settings(conn)?;
            if !remote.enabled {
                return Err(
                    "WeCom connector requires Remote access to be enabled before external Gateway mode can be enabled"
                        .to_string(),
                );
            }
            if remote.gateway_url.is_empty() {
                return Err(
                    "WeCom connector requires a Remote Gateway URL before it can be enabled"
                        .to_string(),
                );
            }
            if !is_supported_gateway_url(&remote.gateway_url) {
                return Err(
                    "WeCom connector requires a valid http(s) or ws(s) Remote Gateway URL"
                        .to_string(),
                );
            }
            if remote.token.is_empty() {
                return Err(
                    "WeCom connector requires a Remote Agent token before external Gateway mode can be enabled"
                        .to_string(),
                );
            }
            if runtime.channel_token.is_empty() {
                return Err(
                    "WeCom connector requires a channel token before it can be enabled".to_string(),
                );
            }
        }
    }

    write_wecom_runtime_settings(conn, &runtime)?;
    Ok(public_wecom_settings(&runtime))
}
