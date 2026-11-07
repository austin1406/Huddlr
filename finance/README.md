# finance/

Plain-code finance engine. No AI here: every number the characters say comes from this folder.

Owner: TBD (P1)

- 45-day forecast, 5 health indicators, plan optimizer, what-if simulator, shortfall flag
- Nessie seed data source and sync (new items detected by ID)
- Tool API served at stable URLs, with a stub that returns fixtures until the real logic lands
- CLI scripts by H8: `post-purchase`, `post-transfer`, `post-paycheck`, `post-bill`, `jump-days N`, `reset`
- The engine takes an `asOf` date from the shared `now()` and never reads the real clock for calendar logic
