package config

import (
	"flag"
	"os"
	"strconv"
	"strings"
	"time"
)

const DefaultGRPCMaxMessageBytes = 64 * 1024 * 1024

const (
	envPrefix       = "ARCFORGE_"
	legacyEnvPrefix = "LIVEAGENT_"
)

type Config struct {
	Token string
	// ChannelToken authenticates the restricted /ws/v2/channel connector.
	// It is intentionally separate from Token (the browser/API credential).
	ChannelToken              string
	ChannelTenantID           string
	ChannelBotID              string
	ChannelConnectorID        string
	ChannelAllowGroupMessages bool
	HTTPAddr                  string
	TLSCert                   string
	TLSKey                    string
	RequestTimeout            time.Duration
	ChatPrepareTimeout        time.Duration
	ChatDeliveryTimeout       time.Duration
	ChatStartTimeout          time.Duration
	ChatRenderStartTimeout    time.Duration
	HeartbeatPeriod           time.Duration
	WebSocketHeartbeatPeriod  time.Duration
	WebSocketHeartbeatGrace   time.Duration
	WebSocketWriteTimeout     time.Duration
	WebSocketWriteQueueSize   int
	GRPCMaxMessageBytes       int
	RelayBufferSeconds        int

	// GRPCAddr is accepted but unused.
	//
	// Deprecated: v1 gRPC 链路已随协议 v2 统一移除，网关不再监听 gRPC 端口；保留本 flag 仅为不破坏既有启动脚本，下个版本删除。
	GRPCAddr string

	// CommandQueueTimeout is accepted but unused.
	//
	// Deprecated: 离线命令队列（生产不可达路径）已随死代码清理移除；保留本 flag 仅为不破坏既有启动脚本，下个版本删除。
	CommandQueueTimeout time.Duration
}

func Load() *Config {
	cfg := &Config{}

	flag.StringVar(&cfg.Token, "token", getenv("ARCFORGE_GATEWAY_TOKEN", ""), "shared authentication token")
	flag.StringVar(&cfg.ChannelToken, "channel-token", getenv("ARCFORGE_GATEWAY_CHANNEL_TOKEN", ""), "restricted channel WebSocket authentication token")
	flag.StringVar(&cfg.ChannelTenantID, "channel-tenant-id", getenv("ARCFORGE_GATEWAY_CHANNEL_TENANT_ID", ""), "optional tenant binding for channel connectors")
	flag.StringVar(&cfg.ChannelBotID, "channel-bot-id", getenv("ARCFORGE_GATEWAY_CHANNEL_BOT_ID", ""), "optional bot binding for channel connectors")
	flag.StringVar(&cfg.ChannelConnectorID, "channel-connector-id", getenv("ARCFORGE_GATEWAY_CHANNEL_CONNECTOR_ID", ""), "optional connector binding for channel connectors")
	flag.BoolVar(&cfg.ChannelAllowGroupMessages, "channel-allow-group-messages", getenvBool("ARCFORGE_GATEWAY_CHANNEL_ALLOW_GROUP_MESSAGES", false), "allow restricted channel group messages")
	flag.StringVar(&cfg.GRPCAddr, "grpc-addr", getenv("ARCFORGE_GATEWAY_GRPC_ADDR", ""), "deprecated, no-op (v1 gRPC removed; kept for startup-script compatibility)")
	flag.StringVar(&cfg.HTTPAddr, "http-addr", getenv("ARCFORGE_GATEWAY_HTTP_ADDR", defaultHTTPAddr()), "HTTP listen address")
	flag.StringVar(&cfg.TLSCert, "tls-cert", getenv("ARCFORGE_GATEWAY_TLS_CERT", ""), "TLS certificate path")
	flag.StringVar(&cfg.TLSKey, "tls-key", getenv("ARCFORGE_GATEWAY_TLS_KEY", ""), "TLS private key path")
	flag.DurationVar(&cfg.RequestTimeout, "request-timeout", getenvDuration("ARCFORGE_GATEWAY_REQUEST_TIMEOUT", 2*time.Minute), "request timeout for non-streaming API calls")
	flag.DurationVar(&cfg.ChatPrepareTimeout, "chat-prepare-timeout", getenvDuration("ARCFORGE_GATEWAY_CHAT_PREPARE_TIMEOUT", 2*time.Second), "timeout for the pre-submit desktop agent liveness probe")
	flag.DurationVar(&cfg.ChatDeliveryTimeout, "chat-delivery-timeout", getenvDuration("ARCFORGE_GATEWAY_CHAT_DELIVERY_TIMEOUT", 5*time.Second), "timeout delivering an accepted chat command to the desktop agent stream")
	flag.DurationVar(&cfg.ChatStartTimeout, "chat-start-timeout", getenvDuration("ARCFORGE_GATEWAY_CHAT_START_TIMEOUT", 5*time.Second), "initial timeout waiting for a delivered remote chat request to start")
	flag.DurationVar(&cfg.ChatRenderStartTimeout, "chat-render-start-timeout", getenvDuration("ARCFORGE_GATEWAY_CHAT_RENDER_START_TIMEOUT", 10*time.Second), "additional timeout waiting for the desktop app to start a delivered remote chat request")
	flag.DurationVar(&cfg.HeartbeatPeriod, "heartbeat-period", getenvDuration("ARCFORGE_GATEWAY_HEARTBEAT_PERIOD", 30*time.Second), "ping interval for agent connection")
	flag.DurationVar(&cfg.WebSocketHeartbeatPeriod, "websocket-heartbeat-period", getenvDuration("ARCFORGE_GATEWAY_WS_HEARTBEAT_PERIOD", 15*time.Second), "ping interval for browser WebSocket connections")
	flag.DurationVar(&cfg.WebSocketHeartbeatGrace, "websocket-heartbeat-grace", getenvDuration("ARCFORGE_GATEWAY_WS_HEARTBEAT_GRACE", 5*time.Second), "extra slack added to the browser WebSocket idle timeout (idle = 3x period + grace)")
	flag.DurationVar(&cfg.WebSocketWriteTimeout, "websocket-write-timeout", getenvDuration("ARCFORGE_GATEWAY_WS_WRITE_TIMEOUT", 10*time.Second), "write timeout for browser WebSocket connections")
	flag.IntVar(&cfg.WebSocketWriteQueueSize, "websocket-write-queue-size", getenvInt("ARCFORGE_GATEWAY_WS_WRITE_QUEUE_SIZE", 512), "write queue buffer size for browser WebSocket connections")
	flag.IntVar(&cfg.GRPCMaxMessageBytes, "grpc-max-message-bytes", getenvInt("ARCFORGE_GATEWAY_GRPC_MAX_MESSAGE_BYTES", DefaultGRPCMaxMessageBytes), "maximum gRPC message size in bytes")
	flag.IntVar(&cfg.RelayBufferSeconds, "relay-buffer-seconds", getenvInt("ARCFORGE_GATEWAY_RELAY_BUFFER_SECONDS", 30), "seconds of chat events to buffer for brief reconnections")
	flag.DurationVar(&cfg.CommandQueueTimeout, "command-queue-timeout", getenvDuration("ARCFORGE_GATEWAY_COMMAND_QUEUE_TIMEOUT", 30*time.Second), "deprecated, no-op (kept for startup-script compatibility)")
	flag.Parse()

	cfg.Token = strings.TrimSpace(cfg.Token)
	cfg.ChannelToken = strings.TrimSpace(cfg.ChannelToken)
	cfg.ChannelTenantID = strings.TrimSpace(cfg.ChannelTenantID)
	cfg.ChannelBotID = strings.TrimSpace(cfg.ChannelBotID)
	cfg.ChannelConnectorID = strings.TrimSpace(cfg.ChannelConnectorID)
	cfg.TLSCert = strings.TrimSpace(cfg.TLSCert)
	cfg.TLSKey = strings.TrimSpace(cfg.TLSKey)

	if cfg.Token == "" {
		flag.Usage()
		panic("gateway token is required")
	}
	if cfg.GRPCMaxMessageBytes <= 0 {
		cfg.GRPCMaxMessageBytes = DefaultGRPCMaxMessageBytes
	}
	if cfg.ChatPrepareTimeout <= 0 {
		cfg.ChatPrepareTimeout = 2 * time.Second
	}
	if cfg.ChatDeliveryTimeout <= 0 {
		cfg.ChatDeliveryTimeout = 5 * time.Second
	}
	if cfg.ChatStartTimeout <= 0 {
		cfg.ChatStartTimeout = 5 * time.Second
	}
	if cfg.ChatRenderStartTimeout <= 0 {
		cfg.ChatRenderStartTimeout = 10 * time.Second
	}
	if cfg.WebSocketHeartbeatPeriod <= 0 {
		cfg.WebSocketHeartbeatPeriod = 15 * time.Second
	}
	if cfg.WebSocketHeartbeatGrace <= 0 {
		cfg.WebSocketHeartbeatGrace = 5 * time.Second
	}
	if cfg.WebSocketWriteTimeout <= 0 {
		cfg.WebSocketWriteTimeout = 10 * time.Second
	}
	if cfg.WebSocketWriteQueueSize <= 0 {
		cfg.WebSocketWriteQueueSize = 512
	}
	if cfg.RelayBufferSeconds <= 0 {
		cfg.RelayBufferSeconds = 30
	}
	if cfg.CommandQueueTimeout <= 0 {
		cfg.CommandQueueTimeout = 30 * time.Second
	}

	return cfg
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	if legacyKey, ok := legacyEnvKey(key); ok {
		if value := os.Getenv(legacyKey); value != "" {
			return value
		}
	}
	return fallback
}

func legacyEnvKey(key string) (string, bool) {
	suffix, ok := strings.CutPrefix(key, envPrefix)
	if !ok {
		return "", false
	}
	return legacyEnvPrefix + suffix, true
}

func defaultHTTPAddr() string {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		return ":443"
	}
	if strings.HasPrefix(port, ":") {
		return port
	}
	return ":" + port
}

func getenvDuration(key string, fallback time.Duration) time.Duration {
	value := getenv(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvInt(key string, fallback int) int {
	value := getenv(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func getenvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(getenv(key, "")))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
