package config

import (
	"flag"
	"io"
	"os"
	"testing"
	"time"
)

func TestLoadNormalizesTokenAndTLSPaths(t *testing.T) {
	t.Setenv("ARCFORGE_GATEWAY_TOKEN", "  secret-token\r\n")
	t.Setenv("ARCFORGE_GATEWAY_CHANNEL_TOKEN", "  channel-secret\r\n")
	t.Setenv("ARCFORGE_GATEWAY_CHANNEL_TENANT_ID", " tenant-1 ")
	t.Setenv("ARCFORGE_GATEWAY_CHANNEL_BOT_ID", " bot-1 ")
	t.Setenv("ARCFORGE_GATEWAY_CHANNEL_CONNECTOR_ID", " connector-1 ")
	t.Setenv("ARCFORGE_GATEWAY_CHANNEL_ALLOW_GROUP_MESSAGES", "true")
	t.Setenv("ARCFORGE_GATEWAY_STATE_DB", " state/gateway.sqlite3 ")
	t.Setenv("ARCFORGE_GATEWAY_TLS_CERT", " cert.pem ")
	t.Setenv("ARCFORGE_GATEWAY_TLS_KEY", "\tkey.pem\r\n")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.Token != "secret-token" {
		t.Fatalf("Token = %q, want %q", cfg.Token, "secret-token")
	}
	if cfg.ChannelToken != "channel-secret" || cfg.ChannelTenantID != "tenant-1" ||
		cfg.ChannelBotID != "bot-1" || cfg.ChannelConnectorID != "connector-1" || !cfg.ChannelAllowGroupMessages {
		t.Fatalf("channel config = token:%q tenant:%q bot:%q connector:%q",
			cfg.ChannelToken, cfg.ChannelTenantID, cfg.ChannelBotID, cfg.ChannelConnectorID)
	}
	if cfg.TLSCert != "cert.pem" {
		t.Fatalf("TLSCert = %q, want %q", cfg.TLSCert, "cert.pem")
	}
	if cfg.TLSKey != "key.pem" {
		t.Fatalf("TLSKey = %q, want %q", cfg.TLSKey, "key.pem")
	}
	if cfg.GatewayStateDB != "state/gateway.sqlite3" {
		t.Fatalf("GatewayStateDB = %q", cfg.GatewayStateDB)
	}
}

func TestLoadEnablesDurableGatewayStateByDefault(t *testing.T) {
	t.Setenv("ARCFORGE_GATEWAY_TOKEN", "dev-token")
	t.Setenv("ARCFORGE_GATEWAY_STATE_DB", "")
	t.Setenv("LIVEAGENT_GATEWAY_STATE_DB", "")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.GatewayStateDB != "arcforge-gateway-state.sqlite3" {
		t.Fatalf("GatewayStateDB default = %q", cfg.GatewayStateDB)
	}
}

func TestLoadWebSocketHeartbeatGrace(t *testing.T) {
	t.Setenv("ARCFORGE_GATEWAY_TOKEN", "dev-token")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace default = %s, want 5s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("ARCFORGE_GATEWAY_WS_HEARTBEAT_GRACE", "45s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 45*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace = %s, want 45s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("ARCFORGE_GATEWAY_WS_HEARTBEAT_GRACE", "-3s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace with negative env = %s, want 5s fallback", cfg.WebSocketHeartbeatGrace)
	}
}

func TestLoadChatTimeouts(t *testing.T) {
	t.Setenv("ARCFORGE_GATEWAY_TOKEN", "dev-token")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.ChatPrepareTimeout != 2*time.Second {
		t.Fatalf("ChatPrepareTimeout default = %s, want 2s", cfg.ChatPrepareTimeout)
	}
	if cfg.ChatDeliveryTimeout != 5*time.Second {
		t.Fatalf("ChatDeliveryTimeout default = %s, want 5s", cfg.ChatDeliveryTimeout)
	}
	if cfg.ChatStartTimeout != 5*time.Second {
		t.Fatalf("ChatStartTimeout default = %s, want 5s", cfg.ChatStartTimeout)
	}
	if cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("ChatRenderStartTimeout default = %s, want 10s", cfg.ChatRenderStartTimeout)
	}

	t.Setenv("ARCFORGE_GATEWAY_CHAT_PREPARE_TIMEOUT", "750ms")
	t.Setenv("ARCFORGE_GATEWAY_CHAT_DELIVERY_TIMEOUT", "3s")
	t.Setenv("ARCFORGE_GATEWAY_CHAT_START_TIMEOUT", "4s")
	t.Setenv("ARCFORGE_GATEWAY_CHAT_RENDER_START_TIMEOUT", "8s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 750*time.Millisecond ||
		cfg.ChatDeliveryTimeout != 3*time.Second ||
		cfg.ChatStartTimeout != 4*time.Second ||
		cfg.ChatRenderStartTimeout != 8*time.Second {
		t.Fatalf("custom chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}

	t.Setenv("ARCFORGE_GATEWAY_CHAT_PREPARE_TIMEOUT", "-1s")
	t.Setenv("ARCFORGE_GATEWAY_CHAT_DELIVERY_TIMEOUT", "0s")
	t.Setenv("ARCFORGE_GATEWAY_CHAT_START_TIMEOUT", "-1s")
	t.Setenv("ARCFORGE_GATEWAY_CHAT_RENDER_START_TIMEOUT", "-1s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 2*time.Second ||
		cfg.ChatDeliveryTimeout != 5*time.Second ||
		cfg.ChatStartTimeout != 5*time.Second ||
		cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("normalized chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}
}

func TestLoadUsesRailwayPortForHTTPDefault(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("ARCFORGE_GATEWAY_TOKEN", "dev-token")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
}

func TestLoadSupportsLegacyEnvironmentNames(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "legacy-token")
	t.Setenv("LIVEAGENT_GATEWAY_HTTP_ADDR", ":4567")
	t.Setenv("LIVEAGENT_GATEWAY_WS_WRITE_QUEUE_SIZE", "99")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.Token != "legacy-token" {
		t.Fatalf("Token = %q, want legacy-token", cfg.Token)
	}
	if cfg.HTTPAddr != ":4567" {
		t.Fatalf("HTTPAddr = %q, want :4567", cfg.HTTPAddr)
	}
	if cfg.WebSocketWriteQueueSize != 99 {
		t.Fatalf("WebSocketWriteQueueSize = %d, want 99", cfg.WebSocketWriteQueueSize)
	}
}

func TestLoadPrefersArcForgeEnvironmentNames(t *testing.T) {
	t.Setenv("ARCFORGE_GATEWAY_TOKEN", "arcforge-token")
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "legacy-token")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.Token != "arcforge-token" {
		t.Fatalf("Token = %q, want arcforge-token", cfg.Token)
	}
}

func resetFlagsForTest(t *testing.T) {
	t.Helper()
	oldCommandLine := flag.CommandLine
	oldArgs := os.Args
	t.Cleanup(func() {
		flag.CommandLine = oldCommandLine
		os.Args = oldArgs
	})

	flag.CommandLine = flag.NewFlagSet("gateway", flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = []string{"gateway"}
}
