.PHONY: setup install keys workspace cli

setup:
	node scripts/local-coding-agent.mjs setup

install:
	node scripts/local-coding-agent.mjs install

keys:
	node scripts/local-coding-agent.mjs keys

workspace:
	node scripts/local-coding-agent.mjs workspace

cli:
	node scripts/local-coding-agent.mjs cli
