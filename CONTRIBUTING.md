# Contributing to DSH Dot

Thanks for taking the time to help. This document is short on purpose: it covers how to run the project, what the project will and will not accept, and how to report a problem that is useful to fix.

## Ways to help

- **Report a bug.** Open an issue with the template. Include the DSH version, the plugin version, and what you expected.
- **Ask for a feature.** Describe the outcome you want, not the implementation. "Dot should tell me when a worker has been stuck for ten minutes" is better than "add a stuck detector".
- **Improve docs.** Documentation fixes are real contributions; open a PR directly.
- **Send a fix.** Small, focused PRs get reviewed fastest.

## Development setup

```bash
git clone https://github.com/1315577677/dsh-dot-plugin.git
cd dsh-dot-plugin
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Then install the working copy into DeepSeek Harness Desktop from **Plugins → install** using its absolute path (`/absolute/path/to/dsh-dot-plugin`).

To try it as a user would, use the tarball in `dist/` after `pnpm pack`.

## Project layout

```
src/host/               Host half: runtime, state, tasks, HTTP routes, review
src/host/orchestrator/  manager tools, task service, coordinator, worker manager
src/host/proactive/     opt-in read-only proactive scanner
src/host/memory/        long-term memory: facts, digest, recall
src/client.ts           Client half: the Dot chat, notifications, plugin settings
test/                   node --test suites
specs/                  design notes for larger changes
```

## What this project will not accept

The safety model is the project. A PR that weakens it needs a design discussion first, not after the code is written.

- **Broadening execution authority.** Dot is a manager. It does not gain file, shell, or network tools in manager mode, and approvals stay with the user for Dot's own proposals.
- **Auto-approving worker actions without review.** Worker approval requests are reviewed by Dot; uncertain requests are escalated to the user. Removing that review is a design change.
- **Making the proactive scanner write.** The scanner is read-only and off by default. It may notify Dot; it may not edit, create tasks, or control Dot's schedules.
- **Silent background writes.** No task, file, or external action may happen without a durable record the user can inspect.
- **Prompt-only safety.** A safety property enforced only by asking the model nicely is not enforced.

## How to send a change

1. Branch from `main`.
2. Keep the change focused: one behavior per PR.
3. Add or update a test. If the behavior is hard to unit test, explain in the PR how you verified it.
4. Run `pnpm typecheck`, `pnpm build`, and `pnpm test`.
5. Open the PR against `main` and describe what changed and why.

Long-running or structural work belongs in `specs/` first. Write the design, get agreement, then implement.

## Code conventions

- TypeScript, ESM, Node 22+.
- No new runtime dependencies unless there is no reasonable alternative; say why in the PR.
- Match the surrounding style. Small functions, explicit errors, no silent catch that hides a real failure.
- User-facing text in both English and Chinese, through the existing locale files.
- Client UI uses host theme tokens (`--dsw-alias-*`); do not hard-code colors.

## Reporting a security issue

Do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository and include reproduction steps.

## License

By contributing you agree that your work is released under the MIT license, the same as the project.
