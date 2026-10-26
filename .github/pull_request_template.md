## Summary
<!-- What does this PR do? -->

## Commit message format
All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>
```

| Type | Version Bump | Use For |
|------|-------------|---------|
| `feat` | Minor (0.x.0) | New features |
| `fix` | Patch (0.0.x) | Bug fixes |
| `docs` | None | Documentation only |
| `chore` | None | Maintenance, deps |
| `refactor` | None | Code changes without feature/fix |
| `test` | None | Adding/updating tests |

Breaking changes: add `!` after type (e.g., `feat!: change auth method`)

## Test plan
- [ ] `pnpm build` succeeds
- [ ] `pnpm lint` passes
- [ ] `pnpm check:public` passes, and this description contains no internal information either
      (this repository is public: no workstation paths, internal repositories, accounts, project
      ids, internal links or ticket ids)
