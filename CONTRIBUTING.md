# Contributing

Thanks for contributing to `agent-vibes`.

## Branching

Open pull requests against `main` unless a maintainer asks otherwise.

Use `dev` as the integration branch when you need to validate changes before
promoting them to `main`.

## Development Setup

```bash
git clone https://github.com/funny-vibes/agent-vibes.git
cd agent-vibes
npm install
npm run dev
```

## Required Checks

Run before opening a PR:

```bash
npm run lint
npm run types
npm run test
npm run build
```

## Commit Convention

This repo uses Conventional Commits:

- `feat:` new features
- `fix:` bug fixes
- `refactor:` code refactors
- `docs:` documentation changes
- `chore:` tooling/build/dependency updates

## Pull Request Expectations

- Keep PRs focused and reviewable
- Include context in the PR description: what changed, why, and how you checked it
- Add or update automated tests when practical
- If no automated test is feasible, include manual verification steps
- Update docs when user-facing behavior or configuration changes

## Secret Handling

Never commit real credentials, tokens, certificates, local account files, or machine-specific runtime data.

Keep these local:

- user-home runtime data under `~/.agent-vibes/` (for example `certs/`, `data/*-accounts.json`, `runtime/`, `logs/`, `config.json`)
- local env files such as `.env*` and `apps/protocol-bridge/.env*`
- repo-local debug-only cert or account files such as `apps/protocol-bridge/certs/*` and `apps/protocol-bridge/data/*-accounts.json`

If you need to share configuration examples, use sanitized placeholders instead of real values.
