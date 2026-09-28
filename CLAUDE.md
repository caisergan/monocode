# MonoCode

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and checks (`npm run check`).

## Git worktrees

- Always create new worktrees under the main checkout's `.worktrees/` folder (`git worktree add .worktrees/<name> ...`), run from the main checkout. Never create them as sibling folders next to the repo.
- `.worktrees/` is git-ignored; keep it that way.
- Move any existing worktree outside it with `git worktree move <old-path> .worktrees/<name>`.
