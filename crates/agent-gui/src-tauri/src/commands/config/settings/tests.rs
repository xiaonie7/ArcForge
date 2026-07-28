#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
    }

    #[test]
    fn initialize_schema_creates_all_tables() {
        let conn = open_memory_db();

        for table in [
            PROVIDER_SETTINGS_TABLE,
            SYSTEM_SETTINGS_TABLE,
            MCP_SETTINGS_TABLE,
            AGENT_PROMPT_TEMPLATES_TABLE,
            SSH_SETTINGS_TABLE,
            REMOTE_SETTINGS_TABLE,
            WECOM_SETTINGS_TABLE,
            MEMORY_SETTINGS_TABLE,
            SSH_PROJECT_HOST_ASSOCIATIONS_TABLE,
            SSH_KNOWN_HOSTS_TABLE,
        ] {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query sqlite_master");
            assert_eq!(exists, 1, "table {table} should exist");
        }
    }

    #[test]
    fn wecom_settings_keep_credentials_out_of_public_payloads() {
        let mut conn = open_memory_db();
        let saved = save_wecom(
            &mut conn,
            json!({
                "enabled": false,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": " bot-a ",
                "tenantId": " ",
                "connectorId": " ",
                "allowGroupMessages": true,
                "accessPolicy": {
                    "rules": [{
                        "tenantId": "bot-a",
                        "botId": "bot-a",
                        "externalUserId": "alice",
                        "scopes": ["tool:read"],
                        "allowedToolNames": ["Read"]
                    }]
                },
                "secretUpdate": " aibot-secret ",
                "channelTokenUpdate": " channel-token "
            }),
        )
        .expect("save WeCom credentials");

        assert_eq!(saved.bot_id, "bot-a");
        assert_eq!(saved.tenant_id, "bot-a");
        assert_eq!(saved.connector_id, "wecom-desktop");
        assert!(saved.secret_configured);
        assert!(saved.channel_token_configured);
        assert!(!saved.enabled);
        assert_eq!(saved.access_policy["rules"][0]["externalUserId"], "alice");

        let public = serde_json::to_value(&saved).expect("serialize public WeCom settings");
        assert!(public.get("secret").is_none());
        assert!(public.get("channelToken").is_none());
        assert!(public.get("secretUpdate").is_none());
        assert!(public.get("channelTokenUpdate").is_none());

        let runtime = load_wecom_runtime_settings(&conn).expect("load runtime WeCom settings");
        assert_eq!(runtime.secret, "aibot-secret");
        assert_eq!(runtime.channel_token, "channel-token");
        assert!(runtime.allow_group_messages);
        assert_eq!(
            serde_json::from_str::<Value>(&runtime.access_policy_json)
                .expect("parse stored access policy")["rules"][0]["externalUserId"],
            "alice"
        );

        save_remote(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayUrl": "not-a-gateway-url",
                "token": "agent-token"
            }),
        )
        .expect("save invalid remote Gateway");
        let invalid_gateway_error = save_wecom(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": "bot-a",
                "tenantId": "bot-a",
                "connectorId": "wecom-desktop",
                "allowGroupMessages": false,
                "secretConfigured": true,
                "channelTokenConfigured": true
            }),
        )
        .expect_err("reject invalid remote Gateway");
        assert!(invalid_gateway_error.contains("valid http(s) or ws(s)"));

        save_remote(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayUrl": "https://gateway.example",
                "token": "agent-token"
            }),
        )
        .expect("save remote Gateway");
        let enabled = save_wecom(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": "bot-a",
                "tenantId": "bot-a",
                "connectorId": "wecom-desktop",
                "allowGroupMessages": false,
                "secretConfigured": true,
                "channelTokenConfigured": true
            }),
        )
        .expect("enable WeCom connector");
        assert!(enabled.enabled);
        assert!(enabled.secret_configured);
        assert!(enabled.channel_token_configured);
        assert_eq!(enabled.access_policy["rules"][0]["externalUserId"], "alice");

        let cleared = save_wecom(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": "bot-a",
                "secretUpdate": null
            }),
        )
        .expect("clear WeCom secret");
        assert!(!cleared.enabled);
        assert!(!cleared.secret_configured);
        assert!(cleared.channel_token_configured);
        assert_eq!(cleared.access_policy["rules"][0]["externalUserId"], "alice");
    }

    #[test]
    fn initialize_schema_migrates_wecom_access_policy_column() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE wecom_settings (
                config_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 0,
                bot_id TEXT NOT NULL DEFAULT '',
                tenant_id TEXT NOT NULL DEFAULT '',
                connector_id TEXT NOT NULL DEFAULT 'wecom-desktop',
                allow_group_messages INTEGER NOT NULL DEFAULT 0,
                aibot_secret TEXT NOT NULL DEFAULT '',
                channel_token TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            );",
        )
        .expect("create legacy WeCom schema");
        conn.execute(
            "INSERT INTO wecom_settings (
                config_id, enabled, bot_id, tenant_id, connector_id,
                allow_group_messages, aibot_secret, channel_token, updated_at
             ) VALUES ('default', 0, 'legacy-bot', 'legacy-tenant',
                       'legacy-connector', 0, '', '', 0)",
            [],
        )
        .expect("insert legacy WeCom settings");

        initialize_schema(&conn).expect("migrate WeCom schema");
        assert!(table_columns(&conn, WECOM_SETTINGS_TABLE)
            .iter()
            .any(|column| column == "access_policy_json"));
        let columns = table_columns(&conn, WECOM_SETTINGS_TABLE);
        assert!(columns.iter().any(|column| column == "gateway_mode"));
        assert!(columns.iter().any(|column| column == "local_gateway_port"));
        let migrated = load_wecom_runtime_settings(&conn).expect("load migrated WeCom settings");
        assert_eq!(migrated.gateway_mode, WecomGatewayMode::Local);
        assert_eq!(migrated.local_gateway_port, 18_780);
    }

    #[test]
    fn initialize_schema_serializes_concurrent_file_migrations() {
        const MIGRATOR_COUNT: usize = 8;

        let temp_dir = tempfile::tempdir().expect("create temporary settings directory");
        let db_path = temp_dir.path().join("concurrent-settings.sqlite");
        let setup_conn = Connection::open(&db_path).expect("open legacy settings database");
        setup_conn
            .execute_batch(
                "CREATE TABLE wecom_settings (
                    config_id TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    bot_id TEXT NOT NULL DEFAULT '',
                    tenant_id TEXT NOT NULL DEFAULT '',
                    connector_id TEXT NOT NULL DEFAULT 'wecom-desktop',
                    allow_group_messages INTEGER NOT NULL DEFAULT 0,
                    aibot_secret TEXT NOT NULL DEFAULT '',
                    channel_token TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO wecom_settings (
                    config_id, enabled, bot_id, tenant_id, connector_id,
                    allow_group_messages, aibot_secret, channel_token, updated_at
                ) VALUES (
                    'default', 0, 'legacy-bot', 'legacy-tenant',
                    'legacy-connector', 0, '', '', 0
                );",
            )
            .expect("create legacy settings schema");
        drop(setup_conn);

        let start = Arc::new(std::sync::Barrier::new(MIGRATOR_COUNT));
        let migrators = (0..MIGRATOR_COUNT)
            .map(|_| {
                let db_path = db_path.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let conn = Connection::open(db_path).expect("open concurrent settings database");
                    conn.busy_timeout(Duration::from_secs(10))
                        .expect("configure concurrent migration busy timeout");
                    start.wait();
                    initialize_schema(&conn)
                })
            })
            .collect::<Vec<_>>();

        for migrator in migrators {
            migrator
                .join()
                .expect("concurrent schema migrator should not panic")
                .expect("concurrent schema migration should succeed");
        }

        let conn = Connection::open(&db_path).expect("reopen migrated settings database");
        let columns = table_columns(&conn, WECOM_SETTINGS_TABLE);
        for column in [
            "access_policy_json",
            "gateway_mode",
            "local_gateway_port",
        ] {
            assert_eq!(
                columns
                    .iter()
                    .filter(|candidate| candidate.as_str() == column)
                    .count(),
                1,
                "concurrent migration should add {column} exactly once",
            );
        }
        let migrated = load_wecom_runtime_settings(&conn).expect("load concurrently migrated row");
        assert_eq!(migrated.bot_id, "legacy-bot");
        assert_eq!(migrated.gateway_mode, WecomGatewayMode::Local);
        assert_eq!(migrated.local_gateway_port, 18_780);
        assert_eq!(
            conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .expect("check migrated database integrity"),
            "ok"
        );
    }

    #[test]
    fn wecom_mode_migration_preserves_configured_external_gateway() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE remote_settings (
                config_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO remote_settings VALUES (
                'default', '{\"gatewayUrl\":\"https://gateway.example\"}', 0
            );
            CREATE TABLE wecom_settings (
                config_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 0,
                bot_id TEXT NOT NULL DEFAULT '',
                tenant_id TEXT NOT NULL DEFAULT '',
                connector_id TEXT NOT NULL DEFAULT 'wecom-desktop',
                allow_group_messages INTEGER NOT NULL DEFAULT 0,
                aibot_secret TEXT NOT NULL DEFAULT '',
                channel_token TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            );
            INSERT INTO wecom_settings VALUES (
                'default', 0, 'legacy-bot', 'legacy-tenant',
                'legacy-connector', 0, '', '', 0
            );",
        )
        .expect("create configured legacy settings");

        initialize_schema(&conn).expect("migrate configured legacy settings");
        let migrated = load_wecom_runtime_settings(&conn).expect("load migrated WeCom settings");
        assert_eq!(migrated.gateway_mode, WecomGatewayMode::External);
    }

    #[test]
    fn local_wecom_mode_does_not_require_external_gateway_credentials() {
        let mut conn = open_memory_db();
        let saved = save_wecom(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayMode": "local",
                "localGatewayPort": 18780,
                "botId": "bot-local",
                "tenantId": "tenant-local",
                "connectorId": "wecom-desktop",
                "secretUpdate": "local-secret"
            }),
        )
        .expect("enable local WeCom runtime without external tokens");

        assert!(saved.enabled);
        assert_eq!(saved.gateway_mode, WecomGatewayMode::Local);
        assert_eq!(saved.local_gateway_port, 18_780);
        assert!(!saved.channel_token_configured);
    }

    #[test]
    fn external_wecom_mode_requires_enabled_remote_with_agent_token() {
        let mut conn = open_memory_db();
        save_wecom(
            &mut conn,
            json!({
                "enabled": false,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": "bot-external",
                "tenantId": "tenant-external",
                "connectorId": "wecom-desktop",
                "secretUpdate": "aibot-secret",
                "channelTokenUpdate": "channel-token"
            }),
        )
        .expect("save external WeCom credentials while disabled");

        save_remote(
            &mut conn,
            json!({
                "enabled": false,
                "gatewayUrl": "https://gateway.example",
                "token": "agent-token"
            }),
        )
        .expect("save disabled Remote settings");
        let remote_disabled_error = save_wecom(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": "bot-external",
                "tenantId": "tenant-external",
                "connectorId": "wecom-desktop"
            }),
        )
        .expect_err("reject external WeCom when Remote is disabled");
        assert!(remote_disabled_error.contains("Remote access to be enabled"));

        save_remote(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayUrl": "https://gateway.example",
                "token": ""
            }),
        )
        .expect("save Remote settings without an Agent token");
        let missing_agent_token_error = save_wecom(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayMode": "external",
                "localGatewayPort": 18780,
                "botId": "bot-external",
                "tenantId": "tenant-external",
                "connectorId": "wecom-desktop"
            }),
        )
        .expect_err("reject external WeCom without a Remote Agent token");
        assert!(missing_agent_token_error.contains("Remote Agent token"));
    }

    #[test]
    fn initialize_schema_creates_columnar_ssh_settings_table() {
        let conn = open_memory_db();
        let columns = table_columns(&conn, SSH_SETTINGS_TABLE);

        for column in [
            "host_id",
            "name",
            "description",
            "host",
            "port",
            "username",
            "auth_type",
            "password",
            "password_configured",
            "private_key",
            "private_key_path",
            "private_key_configured",
            "private_key_passphrase",
            "private_key_passphrase_configured",
            "proxy_json",
            "sort_index",
            "updated_at",
        ] {
            assert!(
                columns.iter().any(|item| item == column),
                "{SSH_SETTINGS_TABLE}.{column} should exist"
            );
        }
        assert!(
            !columns.iter().any(|item| item == "payload_json"),
            "{SSH_SETTINGS_TABLE}.payload_json should not exist"
        );
    }

    #[test]
    fn save_memory_persists_default_payload_and_sync_snapshot() {
        let mut conn = open_memory_db();
        let payload = json!({
            "organizerModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5"
            },
            "summaryModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            }
        });

        save_memory(&mut conn, payload.clone()).expect("save memory settings");

        assert_eq!(
            load_memory(&conn).expect("load memory settings"),
            Some(payload.clone())
        );
        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["memory"], payload);
    }

    #[test]
    fn normalize_remote_settings_repairs_single_slash_gateway_url() {
        let normalized = normalize_remote_settings_payload(RemoteSettingsPayload {
            enabled: true,
            gateway_url: " https:/agent.cnweb.org/ ".to_string(),
            grpc_port: 443,
            grpc_endpoint: " tcp.proxy.rlwy.net:12345/ ".to_string(),
            token: " agent-token-dev ".to_string(),
            agent_id: " mac-mini ".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        });

        assert_eq!(normalized.gateway_url, "https://agent.cnweb.org");
        assert_eq!(normalized.grpc_endpoint, "tcp.proxy.rlwy.net:12345");
        assert_eq!(normalized.token, "agent-token-dev");
        assert_eq!(normalized.agent_id, "mac-mini");
    }

    #[test]
    fn save_providers_persists_one_row_per_provider_and_preserves_order() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]),
        )
        .expect("save providers");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count provider rows");
        let loaded = load_providers(&conn).expect("load providers");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]))
        );
    }

    #[test]
    fn gateway_settings_snapshot_redacts_provider_api_keys() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "secret-key",
                    "apiKeyConfigured": false
                },
                {
                    "id": "provider-b",
                    "name": "B",
                    "apiKey": "",
                    "apiKeyConfigured": true
                }
            ]),
        )
        .expect("save providers");

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][0]["apiKeyConfigured"], true);
        assert_eq!(snapshot["customProviders"][1]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][1]["apiKeyConfigured"], true);
    }

    #[test]
    fn save_ssh_persists_hosts_and_redacts_sync_snapshot() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": "2222",
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyPassphrase": "key-passphrase",
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": "1080",
                            "username": "proxy-user",
                            "password": "proxy-password"
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "username": "ubuntu",
                        "authType": "password",
                        "passwordConfigured": true
                    }
                ],
                "projectHostAssociations": {
                    " /repo/project ": ["prod", "missing", "prod", "staging"],
                    "empty": ["missing"],
                    "  ": ["prod"]
                }
            }),
        )
        .expect("save ssh settings");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM ssh_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count ssh rows");
        let loaded = load_ssh(&conn).expect("load ssh settings");

        assert_eq!(row_count, 2);
        let stored = conn
            .query_row(
                "
                SELECT name, host, port, auth_type, private_key, private_key_passphrase, proxy_json
                FROM ssh_settings
                WHERE host_id = 'prod'
                ",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .expect("load stored ssh columns");
        assert_eq!(stored.0, "Production");
        assert_eq!(stored.1, "prod.example.com");
        assert_eq!(stored.2, 2222);
        assert_eq!(stored.3, "privateKey");
        assert_eq!(
            stored.4,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"
        );
        assert_eq!(stored.5, "key-passphrase");
        assert_eq!(
            parse_json(&stored.6, SSH_SETTINGS_TABLE).expect("parse proxy json"),
            json!({
                "type": "http",
                "url": "http://127.0.0.1",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
                "passwordConfigured": true
            })
        );
        assert_eq!(
            loaded,
            Some(json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": 2222,
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "passwordConfigured": true,
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "key-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 1080,
                            "username": "proxy-user",
                            "password": "proxy-password",
                            "passwordConfigured": true
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "port": 22,
                        "username": "ubuntu",
                        "authType": "password",
                        "password": "",
                        "passwordConfigured": true,
                        "privateKey": "",
                        "privateKeyPath": "",
                        "privateKeyConfigured": false,
                        "privateKeyPassphrase": "",
                        "privateKeyPassphraseConfigured": false,
                        "proxy": {
                            "type": "socks5",
                            "url": "",
                            "port": 0,
                            "username": "",
                            "password": "",
                            "passwordConfigured": false
                        }
                    }
                ],
                "projectHostAssociations": {
                    "/repo/project": ["prod", "staging"]
                }
            }))
        );

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], true);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            true
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["passwordConfigured"],
            true
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][1]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["passwordConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphraseConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["passwordConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["projectHostAssociations"],
            json!({
                "/repo/project": ["prod", "staging"]
            })
        );
    }

    #[test]
    fn save_ssh_keyboard_interactive_host_clears_credential_secret_state() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "kbi-prod",
                        "name": "Keyboard Interactive Production",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "keyboardInteractive",
                        "password": "old-password",
                        "passwordConfigured": true,
                        "privateKey": "old-key",
                        "privateKeyPath": "~/.ssh/id_rsa",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "old-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 8080,
                            "username": "proxy-user",
                            "password": "proxy-password"
                        }
                    }
                ]
            }),
        )
        .expect("save keyboard-interactive ssh settings");

        let loaded = load_ssh(&conn)
            .expect("load ssh settings")
            .expect("ssh settings should exist");
        let host = &loaded["hosts"][0];
        assert_eq!(host["authType"], "keyboardInteractive");
        assert_eq!(host["password"], "");
        assert_eq!(host["passwordConfigured"], false);
        assert_eq!(host["privateKey"], "");
        assert_eq!(host["privateKeyPath"], "");
        assert_eq!(host["privateKeyConfigured"], false);
        assert_eq!(host["privateKeyPassphrase"], "");
        assert_eq!(host["privateKeyPassphraseConfigured"], false);
        assert_eq!(host["proxy"]["passwordConfigured"], true);

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], false);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], false);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            false
        );
    }

    #[test]
    fn initialize_schema_migrates_legacy_agent_auth_to_password() {
        let conn = open_memory_db();
        conn.execute(
            "
            INSERT INTO ssh_settings (
                host_id, name, description, host, port, username, auth_type,
                password, password_configured, private_key, private_key_path,
                private_key_configured, private_key_passphrase,
                private_key_passphrase_configured, proxy_json, sort_index, updated_at
            )
            VALUES ('legacy', 'Legacy', '', 'legacy.example.com', 22, 'deploy', 'agent',
                '', 0, '', '', 0, '', 0, '{}', 0, 0)
            ",
            [],
        )
        .expect("insert legacy agent host");

        initialize_schema(&conn).expect("re-run schema initialization");

        let auth_type: String = conn
            .query_row(
                "SELECT auth_type FROM ssh_settings WHERE host_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated auth type");
        assert_eq!(auth_type, "password");
    }

    #[test]
    fn ssh_patch_delete_preserves_concurrent_hosts_and_associations() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Prod",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "password"
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "host": "staging.example.com",
                        "username": "deploy",
                        "authType": "keyboardInteractive"
                    }
                ],
                "projectHostAssociations": {
                    "/repo": ["prod", "staging"]
                }
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": null
                    }],
                    "projectAssociationChanges": [{
                        "pathKey": "/repo",
                        "before": ["prod"],
                        "after": []
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["id"], "staging");
        assert_eq!(
            response.ssh["projectHostAssociations"],
            json!({
                "/repo": ["staging"]
            })
        );
    }

    #[test]
    fn ssh_patch_rejects_same_field_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod New",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod Web",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict.as_deref(),
            Some(SSH_SYNC_CONFLICT_MESSAGE)
        );
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod New");
    }

    #[test]
    fn ssh_patch_merges_different_host_fields() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod Desktop",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.internal",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod Desktop");
        assert_eq!(response.ssh["hosts"][0]["host"], "prod.internal");
    }

    #[test]
    fn ssh_patch_rejects_auth_type_secret_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "keyboardInteractive"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {},
                "sshSecretUpdates": {
                    "prod": {
                        "password": "secret"
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict.as_deref(),
            Some(SSH_SYNC_CONFLICT_MESSAGE)
        );
    }

    #[test]
    fn ssh_patch_clears_empty_secret_updates() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password",
                    "password": "old-password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": true
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": false
                        }
                    }]
                },
                "sshSecretUpdates": {
                    "prod": {
                        "password": ""
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["password"], "");
        assert_eq!(response.ssh["hosts"][0]["passwordConfigured"], false);
    }

    #[test]
    fn ssh_known_hosts_tracks_unknown_known_and_changed_keys() {
        let conn = open_memory_db();
        let key = RuntimeSshKnownHostKey {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            key_base64: "known-key".to_string(),
            fingerprint_sha256: "SHA256:known".to_string(),
        };

        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check unknown host key"),
            RuntimeSshKnownHostStatus::Unknown
        );

        trust_runtime_ssh_known_host_with_conn(&conn, &key).expect("trust host key");
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check trusted host key"),
            RuntimeSshKnownHostStatus::Known
        );

        let changed = RuntimeSshKnownHostKey {
            key_base64: "changed-key".to_string(),
            fingerprint_sha256: "SHA256:changed".to_string(),
            ..key.clone()
        };
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &changed)
                .expect("check changed host key"),
            RuntimeSshKnownHostStatus::Changed {
                stored_fingerprint: "SHA256:known".to_string()
            }
        );

        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset host key"),
            1
        );
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check reset host key"),
            RuntimeSshKnownHostStatus::Unknown
        );
        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset missing host key"),
            0
        );
    }

    #[test]
    fn save_mcp_persists_one_row_per_server_and_restores_selection() {
        let mut conn = open_memory_db();
        save_mcp(
            &mut conn,
            json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }),
        )
        .expect("save mcp");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM mcp_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count mcp rows");
        let selected_flag = conn
            .query_row(
                "SELECT payload_json FROM mcp_settings WHERE server_id = 'beta'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query beta payload");
        let loaded = load_mcp(&conn).expect("load mcp");

        assert_eq!(row_count, 2);
        assert!(
            selected_flag.contains("\"selected\":true"),
            "selected flag should be stored inline"
        );
        assert_eq!(
            loaded,
            Some(json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }))
        );
    }

    #[test]
    fn save_agents_persists_one_row_per_template_and_restores_columns() {
        let mut conn = open_memory_db();
        save_agents(
            &mut conn,
            json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]),
        )
        .expect("save agents");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM agent_prompt_templates", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count agent rows");
        let stored_enabled = conn
            .query_row(
                "SELECT enabled FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("query reviewer enabled");
        let loaded = load_agents(&conn).expect("load agents");

        assert_eq!(row_count, 2);
        assert_eq!(stored_enabled, 1);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]))
        );
    }

    /// 归一后的 systemProxy 默认值（save/load 全量断言共用）。
    fn default_system_proxy_json() -> Value {
        json!({
            "enabled": false,
            "type": "http",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "passwordConfigured": false
        })
    }

    #[test]
    fn save_system_persists_project_setting_rows() {
        let mut conn = open_memory_db();
        let default_workdir = default_project_workdir().expect("default workdir");
        save_system(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "E:/Code/test_directory/003",
                "selectedSystemTools": ["http_get_test"]
            }),
        )
        .expect("save system");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM system_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count system rows");
        let keys = {
            let mut stmt = conn
                .prepare("SELECT setting_key FROM system_settings ORDER BY setting_key ASC")
                .expect("prepare key query");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query keys");
            rows.into_iter()
                .map(|row| row.expect("key row"))
                .collect::<Vec<_>>()
        };
        let loaded = load_system(&conn).expect("load system");

        assert_eq!(row_count, 9);
        assert_eq!(
            keys,
            vec![
                SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY.to_string(),
                SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_EXECUTION_MODE_KEY.to_string(),
                SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_SELECTED_TOOLS_KEY.to_string(),
                SYSTEM_SYSTEM_PROXY_KEY.to_string(),
                SYSTEM_WORKDIR_KEY.to_string(),
                SYSTEM_WORKSPACE_PROJECTS_KEY.to_string(),
            ]
        );
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "systemProxy": default_system_proxy_json(),
                "workdir": default_workdir.clone(),
                "selectedSystemTools": ["http_get_test"],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": default_workdir.clone(),
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_round_trips_archived_workspace_project_paths() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/arcforge-default-project",
                "selectedSystemTools": [],
                "archivedWorkspaceProjectPaths": [
                    " /tmp/project-a ",
                    "/tmp/project-a",
                    "",
                    42
                ]
            }),
            "/tmp/arcforge-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY),
            Some(&json!(["/tmp/project-a"]))
        );
    }

    #[test]
    fn save_system_backfills_empty_workdir_with_default_project() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "",
                "selectedSystemTools": []
            }),
            "/tmp/arcforge-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/arcforge-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/arcforge-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_preserves_default_project_pin_metadata() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/arcforge-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/arcforge-default-project",
                        "kind": "managed",
                        "createdAt": 10,
                        "updatedAt": 20,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }),
            "/tmp/arcforge-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/arcforge-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/arcforge-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }))
        );
    }

    #[test]
    fn load_system_with_defaults_returns_agent_mode_and_default_project() {
        let conn = open_memory_db();
        let loaded =
            load_system_with_defaults(&conn, "/tmp/arcforge-default-project").expect("load system");

        assert_eq!(
            loaded,
            json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/arcforge-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/arcforge-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            })
        );
    }

    #[test]
    fn expand_home_prefix_supports_bare_tilde() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(expand_home_prefix("~"), home);
    }

    #[test]
    fn expand_home_prefix_supports_forward_slash() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(
            expand_home_prefix("~/OneDrive/ccswitch"),
            home.join("OneDrive/ccswitch")
        );
    }

    #[test]
    fn expand_home_prefix_supports_windows_backslash() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(
            expand_home_prefix("~\\OneDrive\\ccswitch"),
            home.join("OneDrive\\ccswitch")
        );
    }

    #[test]
    fn expand_home_prefix_passes_through_absolute_paths() {
        assert_eq!(
            expand_home_prefix("/data/ccswitch"),
            PathBuf::from("/data/ccswitch")
        );
        assert_eq!(
            expand_home_prefix("C:\\Users\\Alice\\ccswitch"),
            PathBuf::from("C:\\Users\\Alice\\ccswitch")
        );
    }

    #[cfg(windows)]
    #[test]
    fn ccswitch_db_candidates_include_home_env_fallback_on_windows() {
        // 候选列表必须覆盖 ccswitch v3.10.3 在 `%HOME%\.cc-switch\` 的遗留库位置。
        let previous = std::env::var("HOME").ok();
        std::env::set_var("HOME", "C:\\legacy-home");
        let candidates = ccswitch_db_candidates();
        match previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        let expected = PathBuf::from("C:\\legacy-home")
            .join(".cc-switch")
            .join("cc-switch.db");
        assert!(candidates.contains(&expected));
    }

    #[test]
    fn cherry_split_v1_api_keys_handles_escaped_commas() {
        assert_eq!(
            cherry_split_v1_api_keys(r"first\,part, second, ,third"),
            vec!["first,part", "second", "third"]
        );
    }

    #[test]
    fn cherry_manual_data_candidates_support_portable_and_nested_directories() {
        let root = tempfile::tempdir().expect("tempdir");
        let portable = root.path().join("CherryStudioPortable");
        let data = portable.join("data");
        let local_storage = data.join("Local Storage");
        let leveldb = local_storage.join("leveldb");

        let portable_candidates = cherry_manual_data_candidates(&portable);
        assert!(portable_candidates.contains(&portable));
        assert!(portable_candidates.contains(&data));

        let local_storage_candidates = cherry_manual_data_candidates(&local_storage);
        assert!(local_storage_candidates.contains(&data));

        let leveldb_candidates = cherry_manual_data_candidates(&leveldb);
        assert!(leveldb_candidates.contains(&data));
    }

    #[test]
    fn cherry_normalize_routed_base_url_removes_endpoint_marker() {
        assert_eq!(
            cherry_normalize_routed_base_url("https://example.test/v1/chat/completions#"),
            "https://example.test/v1"
        );
        assert_eq!(
            cherry_normalize_routed_base_url(
                "https://generativelanguage.googleapis.com/v1beta/models/demo:generateContent#"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/demo"
        );
    }

    #[test]
    fn cherry_v1_new_api_splits_chat_protocols_and_filters_non_chat_models() {
        let provider = json!({
            "id": "mixed-provider",
            "name": "Mixed API",
            "type": "new-api",
            "apiKey": "secret",
            "apiHost": "https://example.test/v1",
            "enabled": true,
            "models": [
                { "id": "gpt-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] },
                { "id": "claude-chat", "endpoint_type": "anthropic-messages", "type": ["text"] },
                { "id": "text-embedding-3-small", "endpoint_type": "openai-chat-completions", "type": ["embedding"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|item| item.importable));
        assert!(imported.iter().all(|item| item.api_key == "secret"));
        assert!(imported.iter().all(|item| item.excluded_model_count == 1));
        assert!(!cherry_model_is_chat_compatible(
            &json!({"type": ["image_generation"]}),
            "nano-banana"
        ));
        assert!(imported.iter().any(|item| {
            item.provider_type == "codex" && item.request_format == "openai-completions"
        }));
        assert!(imported
            .iter()
            .any(|item| item.provider_type == "claude_code"));
    }
}
