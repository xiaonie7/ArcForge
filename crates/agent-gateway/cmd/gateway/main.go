package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// fatal 记录错误并以非零码退出（slog 没有 Fatal 级别，集中在此处理）。
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

func main() {
	observability.SetupLogging()
	cfg := config.Load()
	//nolint:staticcheck // 读取弃用字段正是为了对旧启动脚本发出弃用警告。
	if cfg.GRPCAddr != "" {
		slog.Warn("-grpc-addr is deprecated and ignored: the v1 gRPC listener was removed; desktop clients connect via /ws/v2/agent on the HTTP port")
	}
	commandStore, err := session.OpenSQLiteChatCommandStore(cfg.GatewayStateDB)
	if err != nil {
		fatal("open gateway state database", "path", cfg.GatewayStateDB, "err", err)
	}
	defer commandStore.Close()
	sm := session.NewManagerWithChatCommandPersistence(commandStore)

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewHTTPServer(cfg, sm),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)

	go func() {
		slog.Info("HTTP listening", "addr", cfg.HTTPAddr)
		var serveErr error
		if cfg.TLSCert != "" || cfg.TLSKey != "" {
			serveErr = httpServer.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			serveErr = httpServer.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		slog.Info("received signal, shutting down", "signal", sig.String())
	case err := <-errCh:
		fatal("server error", "err", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Warn("http shutdown error", "err", err)
	}
}
