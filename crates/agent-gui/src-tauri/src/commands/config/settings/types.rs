#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
    pub providers: Option<Value>,
    pub system: Option<Value>,
    pub mcp: Option<Value>,
    pub agents: Option<Value>,
    pub ssh: Option<Value>,
    pub remote: Option<Value>,
    pub wecom: Option<Value>,
    pub memory: Option<Value>,
    pub default_workdir: String,
}

/// Public WeCom settings returned to the webview. Credential values are
/// deliberately absent; only configured flags cross the Tauri boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WecomSettingsPayload {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub gateway_mode: WecomGatewayMode,
    #[serde(default = "default_wecom_local_gateway_port")]
    pub local_gateway_port: u16,
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub secret_configured: bool,
    #[serde(default)]
    pub channel_token_configured: bool,
    #[serde(default)]
    pub tenant_id: String,
    #[serde(default = "default_wecom_connector_id")]
    pub connector_id: String,
    #[serde(default)]
    pub allow_group_messages: bool,
    #[serde(default = "default_wecom_access_policy")]
    pub access_policy: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WecomGatewayMode {
    Local,
    External,
}

impl Default for WecomGatewayMode {
    fn default() -> Self {
        Self::Local
    }
}

/// Runtime-only settings used by the desktop connector. This type must never
/// be serialized into a settings response or gateway sync snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeWecomSettings {
    pub enabled: bool,
    pub gateway_mode: WecomGatewayMode,
    pub local_gateway_port: u16,
    pub bot_id: String,
    pub tenant_id: String,
    pub connector_id: String,
    pub allow_group_messages: bool,
    pub access_policy_json: String,
    pub secret: String,
    pub channel_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPatchApplyResponse {
    pub ssh: Value,
    pub conflict: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsPayload {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub gateway_url: String,
    #[serde(default = "default_remote_grpc_port")]
    pub grpc_port: u16,
    #[serde(default)]
    pub grpc_endpoint: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default = "default_remote_auto_reconnect")]
    pub auto_reconnect: bool,
    #[serde(default = "default_remote_heartbeat_interval")]
    pub heartbeat_interval: u64,
    #[serde(default)]
    pub enable_web_terminal: bool,
    #[serde(default)]
    pub enable_web_ssh_terminal: bool,
    #[serde(default)]
    pub enable_web_git: bool,
    #[serde(default)]
    pub enable_web_tunnels: bool,
}
#[derive(Debug, Clone)]
pub(crate) struct RuntimeSshProxyConfig {
    pub proxy_type: String,
    pub url: String,
    pub port: i64,
    pub username: String,
    pub password: String,
    pub password_configured: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSshHostConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: String,
    pub private_key: String,
    pub private_key_path: String,
    pub private_key_passphrase: String,
    pub proxy: RuntimeSshProxyConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeSshKnownHostStatus {
    Known,
    Unknown,
    Changed { stored_fingerprint: String },
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSshKnownHostKey {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub key_base64: String,
    pub fingerprint_sha256: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKnownHostResetResponse {
    pub deleted: usize,
}
