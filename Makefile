.PHONY: install setup tunnel-client configure keys workspace cli

-include .env.local

AGENT_MODE ?= safe
AGENT_POLICY ?= balanced
DASHBOARD_PORT ?= 8790
PORT ?= 8789
TUNNEL_BIN ?= $(CURDIR)/tools/tunnel-client
TUNNEL_CLIENT_VERSION ?= v0.0.10
TUNNEL_OS := $(shell uname -s | tr '[:upper:]' '[:lower:]')
TUNNEL_ARCH := $(if $(filter arm64 aarch64,$(shell uname -m)),arm64,amd64)
TUNNEL_CLIENT_URL ?= https://github.com/openai/tunnel-client/releases/download/$(TUNNEL_CLIENT_VERSION)/tunnel-client-$(TUNNEL_CLIENT_VERSION)-$(TUNNEL_OS)-$(TUNNEL_ARCH).zip
TUNNEL_PROFILE ?= local-coding-agent
TUNNEL_PROFILE_DIR ?= $(CURDIR)/tools/profiles
WORKSPACE ?= $(CURDIR)

install:
	bash scripts/lca install

setup: install tunnel-client configure cli

keys:
	@open "https://platform.openai.com/settings/organization/tunnels"
	@open "https://platform.openai.com/settings/organization/api-keys"

workspace:
	@bash scripts/select-workspace.sh

cli:
	@bash scripts/install-cli.sh

tunnel-client:
	@if [ ! -x "$(TUNNEL_BIN)" ]; then \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		mkdir -p "$(dir $(TUNNEL_BIN))"; \
		curl -fsSL "$(TUNNEL_CLIENT_URL)" -o "$$tmp/tunnel-client.zip"; \
		unzip -qo "$$tmp/tunnel-client.zip" -d "$$tmp"; \
		cp "$$tmp/tunnel-client" "$(TUNNEL_BIN)"; \
		chmod +x "$(TUNNEL_BIN)"; \
	fi

configure:
	@[ -f .env.local ] || { echo "Missing .env.local"; exit 1; }
	@set -a; . ./.env.local; set +a; [ -n "$$CONTROL_PLANE_TUNNEL_ID" ] || { echo "Missing CONTROL_PLANE_TUNNEL_ID in .env.local"; exit 1; }
	@bash scripts/lca config set workspace "$(WORKSPACE)"
	@bash scripts/lca config set mode "$(AGENT_MODE)"
	@bash scripts/lca config set policy "$(AGENT_POLICY)"
	@bash scripts/lca config set port "$(PORT)"
	@bash scripts/lca config set dashboardPort "$(DASHBOARD_PORT)"
	@bash scripts/lca config set noTunnel false
	@bash scripts/lca config set tunnelBin "$(TUNNEL_BIN)"
	@bash scripts/lca config set profile "$(TUNNEL_PROFILE)"
	@bash scripts/lca config set profileDir "$(TUNNEL_PROFILE_DIR)"
	@set -a; . ./.env.local; set +a; bash scripts/lca config set tunnelId "$$CONTROL_PLANE_TUNNEL_ID"
	@bash scripts/lca config set runtimeKeyEnv CONTROL_PLANE_API_KEY
	@bash scripts/lca config set openWebUi false
