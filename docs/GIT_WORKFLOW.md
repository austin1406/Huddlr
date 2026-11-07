# Git workflow

Four people, one repo, nobody waiting on anybody. Follow these rules and pushes stay painless.

1. **Own your folder.** Don't edit someone else's folder without messaging them first.
2. **Never push to `main`.** `main` is protected: changes go through a pull request and CI must pass. Never force-push.
3. **Short-lived branches.** Name them `p1/forecast`, `p2/debate`, and so on. After your PR is squash-merged, delete the branch and start a **new** branch from fresh `main`. Reusing a merged branch causes phantom conflicts.
4. **Rhythm.** Pull `main` at the start of every work block. Push your branch every 30-45 minutes, even half-finished. Merge at least every 2 hours, and everyone merges before a gate (H3, H5, H8, H10, H15, H17, H19).
5. **Before opening a PR:** `git fetch && git merge origin/main` into your branch, run your tests, push.
6. **Shared files are additive-only.** In `contracts/`, add fields, never rename or delete. Announce any change in chat.
7. **Dependencies:** add a package in its own tiny PR and merge it right away, then tell the team to pull. Each service folder has its own `package.json` and lockfile, so conflicts stay local. If a lockfile conflicts, take main's version and reinstall: `git checkout origin/main -- package-lock.json && npm install` (run inside that folder).
8. **Database:** each person owns their tables, with migration files prefixed by person (`p2_memory.sql`).
9. **Secrets:** `.env` is gitignored. Share real keys over a private channel, never the repo. Committed a key by accident? Rotate it immediately; deleting the commit is not enough.
10. **Windows and Mac:** `.gitattributes` forces LF line endings. Don't rename files by changing only their case.

## If something goes wrong

- **Merge conflict:** run `git merge origin/main` in your branch and resolve it in your editor. If it's in someone else's folder, ask them.
- **Lockfile conflict:** see rule 7.
- **Pushed a secret:** rotate the key, then tell the team.

## The clock rule

Calendar logic (bills, paychecks, forecast, proposal expiry, quiet hours, daily cap, follow-ups, escalation cutoff, transaction dates) uses the shared `now()` helper, which is the real time plus a simulated offset stored in one `sim_state` row. Delivery mechanics (typing gaps, retries, timeouts, polling, latency metrics) use the real clock. See `contracts/README.md`.
