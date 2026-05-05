# Contributing to Sci

Sci is open source and contributions are welcome. The self-hosted tier is the product — the managed tier proves the self-hosted tier isn't lying. Every contribution to the open source version makes the whole project more trustworthy.

## Contributor License Agreement

By submitting a pull request, you agree to the [Sci Contributor License Agreement (CLA)](CLA.md). The first time you contribute, a bot will ask you to confirm in a comment. This takes 10 seconds and enables your contributions to be included in both the open source and commercial versions of Sci.

## Before you start

- Open an issue first for significant changes — architecture decisions are made deliberately and we want to discuss before you write code
- The privacy guarantee is non-negotiable: no change should cause real identity to appear in outbound prompts
- Run `npm test` before submitting — 17/17 must pass

## Development setup

```bash
git clone https://github.com/sovereign-cognitive-identity/sci
cd sci
npm install
docker compose up -d
npm run build
npm test
```

## Project structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical overview.

Key constraint: `@sci/core` has no MCP dependency. `@sci/mcp` depends on `@sci/core`, not the other way around. This keeps the storage and processing logic portable.

## What we're looking for

- Storage adapter implementations for new backends (GDrive, MinIO, etc.)
- NER improvements — better entity detection, especially for non-English names
- MCP tool additions — new tools that make the memory layer more useful
- Consolidation improvements — better promotion prompts, decay tuning
- Bug reports with reproduction steps

## What we're not looking for (right now)

- New LLM integrations that don't go through the router
- UI additions — the CLI and MCP server are the interface
- Anything that persists the anonymization token map

## Commit style

Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`

## License

Sci is licensed under AGPL-3.0. By contributing, you agree that your contributions are licensed under AGPL-3.0.

If you need to use your contributions in a commercial product without AGPL obligations, contact casey.zandbergen@gmail.com about a commercial license.
